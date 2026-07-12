import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { KeyStoreError } from "./errors.js";
import { loadConfig, type KeyRotatorConfig } from "./config.js";
import {
  applyMigrations,
  generateCredentialID,
  getCredential,
  openCredentialDb,
  parseCredentialValue,
  serializeCredentialValue,
  withWriteTransaction,
  type CredentialRow,
  type CredentialValue,
} from "./opencode-credential-db.js";

export type JsonObject = Record<string, unknown>;
export type Fingerprint = { hash: string; type: "oauth" | "api" | "wellknown" | "unknown"; stability: "stable" | "unstable" };
export type ActiveProvider = { alias: string; credentialID: string; fingerprint: Fingerprint; updatedAt: string };
export type ActiveState = { providers: Record<string, ActiveProvider> };
export type KeyAlias = { providerID: string; alias: string; file?: string; fingerprint: Fingerprint; value?: JsonObject };
export type KeyStatus = {
  providerID: string;
  activeAlias?: string;
  aliases: string[];
  authWarning?: string;
  synced?: boolean;
  connected?: boolean;
  credentialLabel?: string;
};
export type SwitchResult = { providerID: string; previousAlias?: string; activeAlias: string };
export type SaveResult = KeyAlias & { replaced: boolean; fingerprintChanged: boolean };
export type KeyStore = ReturnType<typeof createKeyStore>;

export function createKeyStore(dataDir: string, config?: KeyRotatorConfig) {
  const resolvedDataDir = path.resolve(dataDir);
  const paths = {
    dataDir: resolvedDataDir,
    keysDir: path.join(resolvedDataDir, "keys"),
    lockFile: path.join(resolvedDataDir, "keys", ".lock"),
    rotationLogFile: path.join(resolvedDataDir, "keys", "rotation.log.jsonl"),
    dbFile: path.join(resolvedDataDir, "opencode-next.db"),
  };
  const resolvedConfig = config ?? loadConfig();

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
    return withLock(() => db((database) => withWriteTransaction(database, () => operation(database))));
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
    return db((database) => {
      const credentials = (
        database.prepare("SELECT integration_id FROM credential WHERE integration_id IS NOT NULL").all() as Array<{
          integration_id: string;
        }>
      ).map((row) => row.integration_id);
      const aliases = (
        database.prepare("SELECT integration_id FROM opencode_key_rotator_alias").all() as Array<{ integration_id: string }>
      ).map((row) => row.integration_id);
      return [...new Set([...credentials, ...aliases])].sort();
    });
  }
  function getStatuses(): KeyStatus[] {
    return db((database) => {
      const providers = listProviderIDsInDb(database);
      return providers.map((providerID) => {
        const credential = getCredential(database, providerID);
        const aliases = database
          .prepare("SELECT alias, value FROM opencode_key_rotator_alias WHERE integration_id = ? ORDER BY alias")
          .all(providerID) as Array<{ alias: string; value: string }>;
        const active = activeFor(database, providerID, credential);
        return {
          providerID,
          activeAlias: active?.alias,
          aliases: aliases.map((row) => row.alias),
          synced: credential && active ? true : undefined,
          connected: Boolean(credential),
          credentialLabel: credential?.label,
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
        .run(providerID, alias, serializeCredentialValue(value), previous ? now : now, now);
      if (markActive) markActiveAlias(database, providerID, credential.id, alias, value);
      const fingerprint = calculateFingerprint(value);
      return {
        providerID,
        alias,
        fingerprint,
        replaced: Boolean(previous),
        fingerprintChanged: previous ? !sameFingerprint(calculateFingerprint(parseValue(previous.value)), fingerprint) : false,
      };
    });
  }
  function previewCurrentProviderKey(providerID: string, alias: string) {
    validateProviderID(providerID);
    validateAlias(alias);
    return db((database) => {
      const credential = requireCredential(database, providerID);
      const fingerprint = calculateFingerprint(parseValue(credential.value));
      const existing = database
        .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
        .get(providerID, alias) as { value: string } | undefined;
      const existingFingerprint = existing ? calculateFingerprint(parseValue(existing.value)) : undefined;
      return {
        exists: Boolean(existing),
        fingerprintChanged: Boolean(existingFingerprint && !sameFingerprint(existingFingerprint, fingerprint)),
        fingerprint,
        existingFingerprint,
      };
    });
  }
  function switchProviderKey(providerID: string, alias: string, _reason = "key-switch"): SwitchResult {
    validateProviderID(providerID);
    validateAlias(alias);
    return write((database) => {
      const credential = requireCredential(database, providerID);
      const current = parseValue(credential.value);
      const previous = activeFor(database, providerID, credential);
      if (previous)
        database
          .prepare("UPDATE opencode_key_rotator_alias SET value = ?, time_updated = ? WHERE integration_id = ? AND alias = ?")
          .run(serializeCredentialValue(current), Date.now(), providerID, previous.alias);
      else clearStaleActive(database, providerID);
      const target = database
        .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
        .get(providerID, alias) as { value: string } | undefined;
      if (!target) throw new KeyStoreError("NOT_CONNECTED", `Alias '${providerID}/${alias}' was not found`);
      const next = parseValue(target.value);
      const id = replaceCredential(database, credential, next);
      markActiveAlias(database, providerID, id, alias, next);
      return { providerID, previousAlias: previous?.alias, activeAlias: alias };
    });
  }
  function renameProviderKey(providerID: string, alias: string, newAlias: string): void {
    validateProviderID(providerID);
    validateAlias(alias);
    validateAlias(newAlias);
    write((database) => {
      if (database.prepare("SELECT 1 FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?").get(providerID, newAlias))
        throw new KeyStoreError("ALIAS_COLLISION", `Alias '${providerID}/${newAlias}' already exists`);
      try {
        database
          .prepare("UPDATE opencode_key_rotator_alias SET alias = ?, time_updated = ? WHERE integration_id = ? AND alias = ?")
          .run(newAlias, Date.now(), providerID, alias);
      } catch (error) {
        throw new KeyStoreError("DB_ERROR", String(error));
      }
    });
  }
  function deleteProviderKey(providerID: string, alias: string): void {
    validateProviderID(providerID);
    validateAlias(alias);
    write((database) => {
      const credential = requireCredential(database, providerID);
      const active = activeFor(database, providerID, credential);
      if (active?.alias === alias)
        throw new KeyStoreError("ACTIVE_ALIAS", "The active alias cannot be deleted; switch to another alias first");
      clearStaleActive(database, providerID);
      database.prepare("DELETE FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?").run(providerID, alias);
    });
  }
  function rotateProviderKey(providerID: string): SwitchResult | undefined {
    const keys = listKeys(providerID);
    if (keys.length < 2) return undefined;
    const current = readActiveAliases()[providerID];
    const next = keys[(keys.findIndex((key) => key.alias === current) + 1 + keys.length) % keys.length];
    return switchProviderKey(providerID, next.alias, "auto-rotate");
  }
  function hasAlternativeKey(providerID: string): boolean {
    return listKeys(providerID).length >= 2;
  }
  function keyExists(providerID: string, alias: string): boolean {
    validateProviderID(providerID);
    validateAlias(alias);
    return listKeys(providerID).some((key) => key.alias === alias);
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

  function withLock<T>(operation: () => T): T {
    ensureKeysDir();
    const now = Date.now();
    try {
      fs.writeFileSync(paths.lockFile, JSON.stringify({ pid: process.pid, createdAt: now }), { flag: "wx", mode: 0o600 });
    } catch {
      try {
        if (now - fs.statSync(paths.lockFile).mtimeMs > resolvedConfig.storage.lockTtlMs) {
          fs.rmSync(paths.lockFile, { force: true });
          fs.writeFileSync(paths.lockFile, "{}", { flag: "wx", mode: 0o600 });
        } else throw new Error("busy");
      } catch (error) {
        if (error instanceof KeyStoreError) throw error;
        throw new KeyStoreError("BUSY", "Key store is busy. Try again in a moment.");
      }
    }
    try {
      return operation();
    } finally {
      fs.rmSync(paths.lockFile, { force: true });
    }
  }
  return {
    paths,
    ensureKeysDir,
    listKeys,
    listProviderIDs,
    getStatuses,
    saveCurrentProviderKey,
    previewCurrentProviderKey,
    switchProviderKey,
    renameProviderKey,
    deleteProviderKey,
    rotateProviderKey,
    hasAlternativeKey,
    keyExists,
    readActiveState,
    readActiveAliases,
    calculateFingerprint,
  };

  function aliasFromRow(row: { integration_id: string; alias: string; value: string }): KeyAlias {
    const value = parseValue(row.value);
    return { providerID: row.integration_id, alias: row.alias, fingerprint: calculateFingerprint(value), value };
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
  const row = db.prepare("SELECT * FROM opencode_key_rotator_active WHERE integration_id = ?").get(providerID) as
    | { alias: string; credential_id: string; time_updated: number }
    | undefined;
  if (!row || !credential || row.credential_id !== credential.id) {
    if (row) clearStaleActive(db, providerID);
    return undefined;
  }
  const alias = db
    .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
    .get(providerID, row.alias) as { value: string } | undefined;
  if (!alias || !sameFingerprint(calculateFingerprint(parseValue(alias.value)), calculateFingerprint(parseValue(credential.value)))) {
    clearStaleActive(db, providerID);
    return undefined;
  }
  return {
    alias: row.alias,
    credentialID: row.credential_id,
    fingerprint: calculateFingerprint(parseValue(credential.value)),
    updatedAt: new Date(row.time_updated).toISOString(),
  };
}
function clearStaleActive(db: DatabaseSync, providerID: string): void {
  db.prepare("DELETE FROM opencode_key_rotator_active WHERE integration_id = ?").run(providerID);
}
function markActiveAlias(db: DatabaseSync, providerID: string, credentialID: string, alias: string, value: JsonObject): void {
  db.prepare(
    "INSERT INTO opencode_key_rotator_active(integration_id, credential_id, alias, time_updated) VALUES (?, ?, ?, ?) ON CONFLICT(integration_id) DO UPDATE SET credential_id=excluded.credential_id, alias=excluded.alias, time_updated=excluded.time_updated",
  ).run(providerID, credentialID, alias, Date.now());
}
function replaceCredential(db: DatabaseSync, old: CredentialRow, value: JsonObject): string {
  const id = generateCredentialID(db);
  const now = Date.now();
  db.prepare("DELETE FROM credential WHERE integration_id = ?").run(old.integration_id);
  db.prepare(
    "INSERT INTO credential(id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
  ).run(id, old.integration_id, old.label || "default", JSON.stringify(value), now, now);
  return id;
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
