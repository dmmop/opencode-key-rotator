import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { KeyStoreError } from "./errors.js";

export const PLUGIN_SCHEMA_VERSION = 1;
export type CredentialValue =
  | {
      type: "oauth";
      methodID: string;
      refresh: string;
      access: string;
      expires: number;
      metadata?: Record<string, unknown>;
    }
  | { type: "key"; key: string; metadata?: Record<string, unknown> };

export type CredentialRow = {
  id: string;
  integration_id: string | null;
  label: string;
  value: string;
  connector_id: string | null;
  method_id: string | null;
  active: number | null;
  time_created: number;
  time_updated: number;
};

const UPSTREAM_COLUMNS = new Map([
  ["id", false],
  ["integration_id", false],
  ["label", true],
  ["value", true],
  ["connector_id", false],
  ["method_id", false],
  ["active", false],
  ["time_created", true],
  ["time_updated", true],
]);

export function resolveCredentialDbPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_DB?.trim();
  if (override === ":memory:") throw new KeyStoreError("DB_INVALID", "OPENCODE_DB=:memory: cannot share OpenCode's database");
  if (override) return path.isAbsolute(override) ? override : path.resolve(dataDir, override);
  return path.join(path.resolve(dataDir), "opencode-next.db");
}

export function openCredentialDb(dataDir: string, env: NodeJS.ProcessEnv = process.env): DatabaseSync {
  const filename = resolveCredentialDbPath(dataDir, env);
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(filename);
  } catch (error) {
    throw dbError(error, `Unable to open OpenCode database at ${filename}`);
  }
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    validateCredentialSchema(db);
    applyMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withWriteTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve original */
    }
    throw dbError(error);
  }
}

export function validateCredentialSchema(db: DatabaseSync): void {
  let columns: Array<{ name: string; pk: number; notnull: number; dflt_value: unknown }>;
  try {
    columns = db.prepare("PRAGMA table_info(credential)").all() as typeof columns;
  } catch (error) {
    throw dbError(error, "Unable to inspect OpenCode credential schema");
  }
  if (columns.length === 0) throw new KeyStoreError("DB_SCHEMA", "OpenCode database has no credential table");
  const names = new Set(columns.map((column) => column.name));
  for (const [name, required] of UPSTREAM_COLUMNS) {
    const column = columns.find((item) => item.name === name);
    if (!column || (required && column.notnull !== 1))
      throw new KeyStoreError("DB_SCHEMA", `Unsupported credential schema: missing required column '${name}'`);
    if (name === "id" && column.pk !== 1)
      throw new KeyStoreError("DB_SCHEMA", "Unsupported credential schema: credential.id must be the primary key");
  }
  for (const column of columns)
    if (!UPSTREAM_COLUMNS.has(column.name) && column.notnull === 1 && column.dflt_value === null)
      throw new KeyStoreError("DB_SCHEMA", `Unsupported credential schema: mandatory column '${column.name}'`);
  if (names.size !== columns.length) throw new KeyStoreError("DB_SCHEMA", "Unsupported credential schema");
}

export function applyMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS opencode_key_rotator_migration (version INTEGER PRIMARY KEY, time_applied INTEGER NOT NULL);`);
  const applied = db.prepare("SELECT version FROM opencode_key_rotator_migration WHERE version = ?").get(PLUGIN_SCHEMA_VERSION);
  if (applied) return;
  withWriteTransaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS opencode_key_rotator_alias (
      integration_id TEXT NOT NULL, alias TEXT NOT NULL, value TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      PRIMARY KEY (integration_id, alias));
    CREATE TABLE IF NOT EXISTS opencode_key_rotator_active (
      integration_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, alias TEXT NOT NULL,
      time_updated INTEGER NOT NULL,
      FOREIGN KEY (integration_id, alias) REFERENCES opencode_key_rotator_alias(integration_id, alias)
        ON UPDATE CASCADE ON DELETE RESTRICT);`);
    db.prepare("INSERT INTO opencode_key_rotator_migration(version, time_applied) VALUES (?, ?)").run(PLUGIN_SCHEMA_VERSION, Date.now());
  });
}

export function getCredential(db: DatabaseSync, integrationID: string): CredentialRow | undefined {
  return db.prepare("SELECT * FROM credential WHERE integration_id = ? ORDER BY time_updated DESC LIMIT 1").get(integrationID) as
    | CredentialRow
    | undefined;
}

export function parseCredentialValue(raw: string): CredentialValue {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new KeyStoreError("CREDENTIAL_INVALID", "OpenCode credential value is not valid JSON");
  }
  if (!isRecord(value) || (value.type !== "key" && value.type !== "oauth"))
    throw new KeyStoreError("CREDENTIAL_INVALID", "Unsupported OpenCode credential value type");
  if (value.type === "key" && typeof value.key === "string" && value.key.length > 0) return value as CredentialValue;
  if (
    value.type === "oauth" &&
    typeof value.methodID === "string" &&
    value.methodID &&
    typeof value.refresh === "string" &&
    value.refresh &&
    typeof value.access === "string" &&
    value.access &&
    Number.isInteger(value.expires)
  )
    return value as CredentialValue;
  throw new KeyStoreError("CREDENTIAL_INVALID", "OpenCode credential value has an invalid shape");
}

export function serializeCredentialValue(value: CredentialValue): string {
  return JSON.stringify(value);
}

export function dbError(error: unknown, fallback?: string): KeyStoreError {
  if (error instanceof KeyStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/i.test(message)) return new KeyStoreError("BUSY", message);
  return new KeyStoreError("DB_ERROR", fallback ? `${fallback}: ${message}` : message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
