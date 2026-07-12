import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KeyStoreError } from "./errors.js";
import { calculateFingerprintForCredential, type JsonObject } from "./migration-types.js";
import {
  generateCredentialID,
  openCredentialDb,
  parseCredentialValue,
  resolveCredentialDbPath,
  serializeCredentialValue,
  withWriteTransaction,
} from "./opencode-credential-db.js";

export type MigrationOptions = { dataDir: string; providerID?: string; methodID?: string; dbFile?: string; dryRun?: boolean };
export type MigrationReport = { imported: string[]; skipped: string[]; conflicts: string[]; createdCredential: boolean; dryRun: boolean };

export function migrateLegacy(options: MigrationOptions): MigrationReport {
  const dataDir = path.resolve(options.dataDir);
  const dbPath = options.dbFile
    ? path.isAbsolute(options.dbFile)
      ? options.dbFile
      : path.resolve(dataDir, options.dbFile)
    : resolveCredentialDbPath(dataDir);
  const env = { ...process.env, OPENCODE_DB: dbPath };
  let db: DatabaseSync;
  try {
    db = openCredentialDb(dataDir, env);
  } catch (error) {
    if (!(error instanceof KeyStoreError) || error.code !== "DB_SCHEMA") throw error;
    db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, integration_id TEXT NULL, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT NULL, method_id TEXT NULL, active INTEGER NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`,
    );
    db.close();
    db = openCredentialDb(dataDir, env);
  }
  try {
    const candidates = scanLegacy(dataDir, options.providerID);
    const report: MigrationReport = { imported: [], skipped: [], conflicts: [], createdCredential: false, dryRun: Boolean(options.dryRun) };
    const current = currentCredentials(db, options.providerID);
    for (const candidate of candidates) {
      const value = convertLegacy(candidate.value, current.get(candidate.providerID), options.methodID, candidate.providerID);
      if (!value) {
        report.skipped.push(
          `${candidate.providerID}/${candidate.alias}: ${legacyCredentialReason(candidate.value, current.get(candidate.providerID), options.methodID, candidate.providerID)}`,
        );
        continue;
      }
      const existing = db
        .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
        .get(candidate.providerID, candidate.alias) as { value: string } | undefined;
      if (existing && JSON.stringify(parseCredentialValue(existing.value)) === JSON.stringify(value))
        report.skipped.push(`${candidate.providerID}/${candidate.alias}: already imported`);
      else report.imported.push(`${candidate.providerID}/${candidate.alias}`);
    }
    for (const row of current.values()) {
      if (!row.integration_id) continue;
      const label = row.label || "default";
      const value = parseCredentialValue(row.value);
      const same = db.prepare("SELECT alias FROM opencode_key_rotator_alias WHERE integration_id = ?").all(row.integration_id) as Array<{
        alias: string;
      }>;
      const duplicate = same.find((alias) => {
        const item = db
          .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
          .get(row.integration_id, alias.alias) as { value: string };
        return sameFingerprint(
          calculateFingerprintForCredential(parseCredentialValue(item.value)),
          calculateFingerprintForCredential(value),
        );
      });
      if (!duplicate) {
        if (same.some((item) => item.alias === label))
          report.conflicts.push(`${row.integration_id}/${label} kept as v2 label; legacy alias renamed`);
        report.imported.push(`${row.integration_id}/${label}`);
      } else report.skipped.push(`${row.integration_id}/${duplicate.alias}: current credential already represented`);
    }
    if (candidates.length > 0 && report.imported.length === 0 && report.skipped.some((entry) => !entry.includes("already imported")))
      throw new KeyStoreError(
        "MIGRATION_EMPTY",
        `Migration imported zero credentials; ${report.skipped.filter((entry) => !entry.includes("already imported")).join("; ")}`,
      );
    if (options.dryRun) return report;
    withWriteTransaction(db, () => {
      for (const candidate of candidates) {
        if (current.has(candidate.providerID)) continue;
        const value = convertLegacy(candidate.value, undefined, options.methodID, candidate.providerID);
        if (!value) continue;
        const now = Date.now();
        const id = generateCredentialID(db);
        db.prepare(
          "INSERT INTO credential(id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
        ).run(id, candidate.providerID, "default", serializeCredentialValue(value), now, now);
        current.set(candidate.providerID, {
          id,
          integration_id: candidate.providerID,
          label: "default",
          value: serializeCredentialValue(value),
        });
        report.createdCredential = true;
      }
      for (const candidate of candidates) {
        const value = convertLegacy(candidate.value, current.get(candidate.providerID), options.methodID, candidate.providerID);
        if (!value) continue;
        let alias = candidate.alias;
        const collision = db
          .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
          .get(candidate.providerID, alias) as { value: string } | undefined;
        if (collision && JSON.stringify(parseCredentialValue(collision.value)) !== JSON.stringify(value))
          alias = uniqueLegacyAlias(db, candidate.providerID, alias);
        const now = Date.now();
        db.prepare(
          "INSERT INTO opencode_key_rotator_alias(integration_id, alias, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(integration_id, alias) DO UPDATE SET value=excluded.value, time_updated=excluded.time_updated",
        ).run(candidate.providerID, alias, serializeCredentialValue(value), now, now);
      }
      for (const row of current.values()) {
        if (!row.integration_id) continue;
        let alias = row.label || "default";
        const collision = db
          .prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?")
          .get(row.integration_id, alias) as { value: string } | undefined;
        if (
          collision &&
          !sameFingerprint(
            calculateFingerprintForCredential(parseCredentialValue(collision.value)),
            calculateFingerprintForCredential(parseCredentialValue(row.value)),
          )
        )
          alias = uniqueLegacyAlias(db, row.integration_id, alias);
        const now = Date.now();
        db.prepare(
          "INSERT INTO opencode_key_rotator_alias(integration_id, alias, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(integration_id, alias) DO UPDATE SET value=excluded.value, time_updated=excluded.time_updated",
        ).run(row.integration_id, alias, row.value, now, now);
        db.prepare(
          "INSERT INTO opencode_key_rotator_active(integration_id, credential_id, alias, time_updated) VALUES (?, ?, ?, ?) ON CONFLICT(integration_id) DO UPDATE SET credential_id=excluded.credential_id, alias=excluded.alias, time_updated=excluded.time_updated",
        ).run(row.integration_id, row.id, alias, now);
      }
    });
    return report;
  } finally {
    db.close();
  }
}

type Candidate = { providerID: string; alias: string; value: JsonObject };
type Current = { id: string; integration_id: string | null; label: string; value: string };
function scanLegacy(dataDir: string, providerFilter?: string): Candidate[] {
  const result: Candidate[] = [];
  const keys = path.join(dataDir, "keys");
  for (const providerID of providerFilter ? [providerFilter] : safeDirs(keys)) {
    const dir = path.join(keys, providerID);
    for (const file of safeFiles(dir))
      if (file.endsWith(".json") && file !== "active.json") {
        try {
          result.push({ providerID, alias: file.slice(0, -5), value: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) });
        } catch {}
      }
  }
  const authPath = path.join(dataDir, "auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, JsonObject>;
      const active = readLegacyActive(dataDir);
      for (const [providerID, value] of Object.entries(auth))
        if (!providerFilter || providerID === providerFilter)
          if (
            !result.some(
              (item) =>
                item.providerID === providerID &&
                sameFingerprint(calculateFingerprintForCredential(item.value), calculateFingerprintForCredential(value)),
            )
          )
            result.push({ providerID, alias: active[providerID] ?? "default", value });
    } catch {}
  }
  return result;
}
function readLegacyActive(dataDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "keys", "active.json"), "utf8")) as {
      providers?: Record<string, { alias?: string }>;
    };
    return Object.fromEntries(Object.entries(parsed.providers ?? {}).flatMap(([key, value]) => (value.alias ? [[key, value.alias]] : [])));
  } catch {
    return {};
  }
}
function currentCredentials(db: DatabaseSync, providerID?: string): Map<string, Current> {
  const rows = (
    providerID
      ? db.prepare("SELECT id, integration_id, label, value FROM credential WHERE integration_id = ?").all(providerID)
      : db.prepare("SELECT id, integration_id, label, value FROM credential WHERE integration_id IS NOT NULL").all()
  ) as Current[];
  return new Map(rows.map((row) => [row.integration_id as string, row]));
}
function convertLegacy(value: JsonObject, current: Current | undefined, overrideMethod?: string, providerID?: string) {
  if (value.type === "api" && typeof value.key === "string" && value.key)
    return { type: "key" as const, key: value.key, ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}) };
  if (value.type === "oauth" && typeof value.access === "string" && value.access && typeof value.refresh === "string" && value.refresh) {
    const currentValue = current ? parseCredentialValue(current.value) : undefined;
    const methodID =
      currentValue?.type === "oauth"
        ? currentValue.methodID
        : (overrideMethod ?? (providerID === "openai" ? "chatgpt-browser" : undefined));
    const expires = typeof value.expires === "number" && Number.isInteger(value.expires) ? value.expires : undefined;
    if (methodID && expires !== undefined)
      return {
        type: "oauth" as const,
        methodID,
        access: value.access,
        refresh: value.refresh,
        expires,
        ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
      };
  }
  return undefined;
}
function uniqueLegacyAlias(db: DatabaseSync, providerID: string, alias: string): string {
  let index = 0;
  for (;;) {
    const candidate = `${alias} (legacy)${index ? ` ${index}` : ""}`;
    if (!db.prepare("SELECT 1 FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?").get(providerID, candidate))
      return candidate;
    index += 1;
  }
}
function sameFingerprint(a: { hash: string }, b: { hash: string }): boolean {
  return a.hash === b.hash;
}
function safeDirs(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !new Set(["backups", ".lock", ".", ".."]).has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function legacyCredentialReason(
  value: JsonObject,
  current: Current | undefined,
  overrideMethod: string | undefined,
  providerID: string,
): string {
  if (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access &&
    typeof value.refresh === "string" &&
    value.refresh &&
    typeof value.expires === "number" &&
    Number.isInteger(value.expires)
  ) {
    const currentValue = current ? parseCredentialValue(current.value) : undefined;
    const methodID =
      currentValue?.type === "oauth"
        ? currentValue.methodID
        : (overrideMethod ?? (providerID === "openai" ? "chatgpt-browser" : undefined));
    if (!methodID)
      return "unsupported OAuth integration: no v2 methodID adapter (provide --method-id only when OpenCode has a matching implementation)";
  }
  return "invalid credential shape";
}
function safeFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
