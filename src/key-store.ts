import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { KeyStoreError } from "./errors.js";
import {
  getCredential,
  openCredentialDb,
  parseCredentialValue,
  serializeCredentialValue,
  withWriteTransaction,
  type CredentialRow,
  type CredentialValue,
} from "./opencode-credential-db.js";

export type JsonObject = Record<string, unknown>;
export type Fingerprint = { hash: string; type: "oauth" | "api" | "unknown"; stability: "stable" | "unstable" };
export type ActiveProvider = { alias: string; credentialID: string; fingerprint: Fingerprint; updatedAt: string };
export type ActiveState = { providers: Record<string, ActiveProvider> };
export type KeyAlias = { providerID: string; alias: string; fingerprint: Fingerprint; value?: JsonObject };
export type KeyStatus = {
  providerID: string;
  activeAlias?: string;
  aliases: string[];
  synced?: boolean;
  connected?: boolean;
};
export type SwitchResult = { providerID: string; previousAlias?: string; activeAlias: string };
export type SaveResult = KeyAlias & { replaced: boolean };
export type KeyStore = ReturnType<typeof createKeyStore>;

export function createKeyStore(dataDir: string) {
  const resolvedDataDir = path.resolve(dataDir);
  const paths = {
    dataDir: resolvedDataDir,
    keysDir: path.join(resolvedDataDir, "keys"),
    rotationLogFile: path.join(resolvedDataDir, "keys", "rotation.log.jsonl"),
    dbFile: path.join(resolvedDataDir, "opencode-next.db"),
  };
  function ensureKeysDir(): void {
    fs.mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(paths.keysDir, 0o700);
    } catch {}
  }
  function db<T>(operation: (database: DatabaseSync) => T): T {
    const database = openCredentialDb(resolvedDataDir);
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
  function write<T>(operation: (database: DatabaseSync) => T): T {
    return db((database) => withWriteTransaction(database, () => operation(database)));
  }

  function listKeys(providerID?: string): KeyAlias[] {
    return db((database) => {
      const rows = (
        providerID
          ? database.prepare("SELECT * FROM opencode_key_rotator_alias WHERE integration_id = ? ORDER BY alias").all(providerID)
          : database.prepare("SELECT * FROM opencode_key_rotator_alias ORDER BY integration_id, alias").all()
      ) as Array<{ integration_id: string; alias: string; value: string }>;
      return rows.map((row) => aliasFromRow(row));
    });
  }
  function listProviderIDs(): string[] {
    return db(listProviderIDsInDb);
  }
  function getStatuses(): KeyStatus[] {
    return db((database) => {
      const providers = listProviderIDsInDb(database);
      return providers.map((providerID) => {
        const credential = getCredential(database, providerID);
        const aliases = database
          .prepare("SELECT alias, value FROM opencode_key_rotator_alias WHERE integration_id = ? ORDER BY alias")
          .all(providerID) as Array<{ alias: string; value: string }>;
        const active = inspectActive(database, providerID, credential);
        return {
          providerID,
          activeAlias: active.value?.alias ?? active.staleAlias,
          aliases: aliases.map((row) => row.alias),
          synced: active.value ? true : active.staleAlias ? false : undefined,
          connected: Boolean(credential),
        };
      });
    });
  }
  function saveCurrentProviderKey(providerID: string, alias: string, markActive: boolean): SaveResult {
    validateProviderID(providerID);
    validateAlias(alias);
    return write((database) => {
      const credential = requireCredential(database, providerID);
      const value = parseValue(credential.value);
      const previous = database
        .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
        .get(providerID, alias) as { value: string } | undefined;
      const now = Date.now();
      database
        .prepare(
          `INSERT INTO opencode_key_rotator_alias(integration_id, alias, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(integration_id, alias) DO UPDATE SET value=excluded.value, time_updated=excluded.time_updated`,
        )
        .run(providerID, alias, serializeCredentialValue(value), now, now);
      if (markActive) markActiveAlias(database, providerID, credential.id, alias);
      const fingerprint = calculateFingerprint(value);
      return {
        providerID,
        alias,
        fingerprint,
        replaced: Boolean(previous),
      };
    });
  }
  function switchProviderKey(providerID: string, alias: string, _reason = "key-switch"): SwitchResult {
    validateProviderID(providerID);
    validateAlias(alias);
    return write((database) => {
      const credential = requireCredential(database, providerID);
      const previous = activeFor(database, providerID, credential);
      return switchToAlias(database, providerID, credential, previous, alias);
    });
  }
  function switchProviderKeyToNext(providerID: string, availableAliases: string[], _reason = "auto-rotate"): SwitchResult | undefined {
    validateProviderID(providerID);
    for (const alias of availableAliases) validateAlias(alias);
    return write((database) => {
      const credential = requireCredential(database, providerID);
      const previous = activeFor(database, providerID, credential);
      const aliases = database
        .prepare("SELECT alias FROM opencode_key_rotator_alias WHERE integration_id = ? ORDER BY alias")
        .all(providerID) as Array<{ alias: string }>;
      const allowed = new Set(availableAliases);
      const currentIndex = previous ? aliases.findIndex((row) => row.alias === previous.alias) : -1;
      let targetAlias: string | undefined;
      for (let offset = 1; offset <= aliases.length; offset += 1) {
        const alias = aliases[(currentIndex + offset + aliases.length) % aliases.length]?.alias;
        if (alias && alias !== previous?.alias && allowed.has(alias)) {
          targetAlias = alias;
          break;
        }
      }
      if (!targetAlias) return undefined;
      return switchToAlias(database, providerID, credential, previous, targetAlias);
    });
  }
  function renameProviderKey(providerID: string, alias: string, newAlias: string): void {
    validateProviderID(providerID);
    validateAlias(alias);
    validateAlias(newAlias);
    write((database) => {
      const existing = database
        .prepare("SELECT COUNT(*) AS count FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
        .get(providerID, newAlias) as { count: number };
      if (existing.count > 0) throw new KeyStoreError("ALIAS_COLLISION", `Alias '${providerID}/${newAlias}' already exists`);
      try {
        const result = database
          .prepare("UPDATE opencode_key_rotator_alias SET alias = ?, time_updated = ? WHERE integration_id = ? AND alias = ?")
          .run(newAlias, Date.now(), providerID, alias);
        if (result.changes === 0) throw new KeyStoreError("NOT_CONNECTED", `Alias '${providerID}/${alias}' was not found`);
      } catch (error) {
        if (error instanceof KeyStoreError) throw error;
        throw new KeyStoreError("DB_ERROR", String(error));
      }
    });
  }
  function deleteProviderKey(providerID: string, alias: string): void {
    validateProviderID(providerID);
    validateAlias(alias);
    write((database) => {
      const active = inspectActive(database, providerID, getCredential(database, providerID));
      if ((active.value?.alias ?? active.staleAlias) === alias)
        throw new KeyStoreError("ACTIVE_ALIAS", "The active alias cannot be deleted; switch to another alias first");
      const result = database
        .prepare("DELETE FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
        .run(providerID, alias);
      if (result.changes === 0) throw new KeyStoreError("NOT_CONNECTED", `Alias '${providerID}/${alias}' was not found`);
    });
  }
  function readActiveState(): ActiveState {
    return db((database) => {
      const state: ActiveState = { providers: {} };
      for (const providerID of listProviderIDsInDb(database)) {
        const credential = getCredential(database, providerID);
        const active = activeFor(database, providerID, credential);
        if (active) state.providers[providerID] = active;
      }
      return state;
    });
  }
  function readActiveAliases(): Record<string, string> {
    return Object.fromEntries(Object.entries(readActiveState().providers).map(([provider, active]) => [provider, active.alias]));
  }

  return {
    paths,
    ensureKeysDir,
    listKeys,
    listProviderIDs,
    getStatuses,
    saveCurrentProviderKey,
    switchProviderKey,
    switchProviderKeyToNext,
    renameProviderKey,
    deleteProviderKey,
    readActiveState,
    readActiveAliases,
    calculateFingerprint,
  };

  function aliasFromRow(row: { integration_id: string; alias: string; value: string }): KeyAlias {
    const value = parseValue(row.value);
    return { providerID: row.integration_id, alias: row.alias, fingerprint: calculateFingerprint(value) };
  }
}

function listProviderIDsInDb(db: DatabaseSync): string[] {
  return [
    ...new Set([
      ...(
        db.prepare("SELECT integration_id FROM credential WHERE integration_id IS NOT NULL").all() as Array<{ integration_id: string }>
      ).map((row) => row.integration_id),
      ...(db.prepare("SELECT integration_id FROM opencode_key_rotator_alias").all() as Array<{ integration_id: string }>).map(
        (row) => row.integration_id,
      ),
    ]),
  ].sort();
}
function requireCredential(db: DatabaseSync, providerID: string): CredentialRow {
  const row = getCredential(db, providerID);
  if (!row) throw new KeyStoreError("NOT_CONNECTED", `Provider '${providerID}' has no connected credential`);
  parseValue(row.value);
  return row;
}
function parseValue(value: string): CredentialValue {
  return parseCredentialValue(value);
}
function activeFor(db: DatabaseSync, providerID: string, credential: CredentialRow | undefined): ActiveProvider | undefined {
  return inspectActive(db, providerID, credential).value;
}
function inspectActive(
  db: DatabaseSync,
  providerID: string,
  credential: CredentialRow | undefined,
): { value?: ActiveProvider; staleAlias?: string } {
  const row = db.prepare("SELECT * FROM opencode_key_rotator_active WHERE integration_id = ?").get(providerID) as
    | { alias: string; credential_id: string; time_updated: number }
    | undefined;
  if (!row) return {};
  if (!credential) return { staleAlias: row.alias };
  const alias = db
    .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
    .get(providerID, row.alias) as { value: string } | undefined;
  const credentialFingerprint = calculateFingerprint(parseValue(credential.value));
  if (!alias || !sameFingerprint(calculateFingerprint(parseValue(alias.value)), credentialFingerprint)) return { staleAlias: row.alias };
  return {
    value: {
      alias: row.alias,
      credentialID: row.credential_id,
      fingerprint: credentialFingerprint,
      updatedAt: new Date(row.time_updated).toISOString(),
    },
  };
}
function clearStaleActive(db: DatabaseSync, providerID: string): void {
  db.prepare("DELETE FROM opencode_key_rotator_active WHERE integration_id = ?").run(providerID);
}
function switchToAlias(
  db: DatabaseSync,
  providerID: string,
  credential: CredentialRow,
  previous: ActiveProvider | undefined,
  targetAlias: string,
): SwitchResult {
  const target = db
    .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
    .get(providerID, targetAlias) as { value: string } | undefined;
  if (!target) throw new KeyStoreError("NOT_CONNECTED", `Alias '${providerID}/${targetAlias}' was not found`);

  if (previous && previous.alias !== targetAlias)
    db.prepare("UPDATE opencode_key_rotator_alias SET value = ?, time_updated = ? WHERE integration_id = ? AND alias = ?").run(
      serializeCredentialValue(parseValue(credential.value)),
      Date.now(),
      providerID,
      previous.alias,
    );
  else if (!previous) clearStaleActive(db, providerID);

  const next = parseValue(target.value);
  replaceCredential(db, credential, next);
  markActiveAlias(db, providerID, credential.id, targetAlias);
  return { providerID, previousAlias: previous?.alias, activeAlias: targetAlias };
}
function markActiveAlias(db: DatabaseSync, providerID: string, credentialID: string, alias: string): void {
  db.prepare(
    "INSERT INTO opencode_key_rotator_active(integration_id, credential_id, alias, time_updated) VALUES (?, ?, ?, ?) ON CONFLICT(integration_id) DO UPDATE SET credential_id=excluded.credential_id, alias=excluded.alias, time_updated=excluded.time_updated",
  ).run(providerID, credentialID, alias, Date.now());
}
function replaceCredential(db: DatabaseSync, old: CredentialRow, value: JsonObject): void {
  db.prepare("UPDATE credential SET value = ?, time_updated = ? WHERE id = ?").run(JSON.stringify(value), Date.now(), old.id);
}
function calculateFingerprint(credential: JsonObject): Fingerprint {
  const type = credential.type;
  if (type === "oauth") {
    const methodID = typeof credential.methodID === "string" ? credential.methodID : "";
    const metadata = credential.metadata as JsonObject | undefined;
    const account = typeof metadata?.accountID === "string" ? metadata.accountID : jwtAccount(credential.access);
    if (account) return fingerprint("oauth", "stable", [type, methodID, account]);
    return fingerprint("oauth", "unstable", [type, methodID, String(credential.refresh ?? ""), String(credential.access ?? "")]);
  }
  if (type === "key") return fingerprint("api", "stable", [type, String(credential.key ?? "")]);
  return fingerprint("unknown", "unstable", [
    JSON.stringify(
      Object.fromEntries(
        Object.keys(credential)
          .sort()
          .map((key) => [key, typeof credential[key]]),
      ),
    ),
  ]);
}
function jwtAccount(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  try {
    const part = token.split(".")[1];
    const payload = JSON.parse(Buffer.from(part, "base64url").toString()) as JsonObject;
    return typeof payload.account_id === "string" ? payload.account_id : undefined;
  } catch {
    return undefined;
  }
}
function fingerprint(type: Fingerprint["type"], stability: Fingerprint["stability"], parts: string[]): Fingerprint {
  return { hash: `sha256:${crypto.createHash("sha256").update(parts.join("\0")).digest("hex")}`, type, stability };
}
function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.hash === right.hash && left.type === right.type && left.stability === right.stability;
}
function validateProviderID(providerID: string): void {
  if (!providerID || providerID.length > 200 || /[\u0000-\u001f\u007f]/.test(providerID))
    throw new KeyStoreError("INVALID_INPUT", "Invalid provider ID");
}
function validateAlias(alias: string): void {
  if (typeof alias !== "string" || !alias.trim() || alias.length > 200 || /[\u0000-\u001f\u007f]/.test(alias))
    throw new KeyStoreError("INVALID_INPUT", "Alias must be a non-empty label without control characters");
}
