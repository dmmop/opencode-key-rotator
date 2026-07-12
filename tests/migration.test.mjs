import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateLegacy } from "../dist/migration.js";

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-migration-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function openDb(dir) {
  return new DatabaseSync(path.join(dir, "opencode-next.db"));
}

function createCredentialTable(dir) {
  const db = openDb(dir);
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT NULL, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT NULL, method_id TEXT NULL, active INTEGER NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  );
  db.close();
}

test("migrates legacy API aliases and creates the active OpenCode credential", () => {
  const dir = dataDir();
  writeJson(path.join(dir, "keys", "openai", "work.json"), { type: "api", key: "work-key" });
  writeJson(path.join(dir, "keys", "openai", "personal.json"), { type: "api", key: "personal-key" });

  const report = migrateLegacy({ dataDir: dir });

  assert.deepEqual(report.imported.sort(), ["openai/personal", "openai/work"]);
  assert.equal(report.createdCredential, true);

  const db = openDb(dir);
  const credential = JSON.parse(db.prepare("SELECT value FROM credential WHERE integration_id = 'openai'").get().value);
  assert.equal(credential.type, "key");
  assert.ok(["work-key", "personal-key"].includes(credential.key));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_key_rotator_alias").get().count, 3);
  assert.equal(db.prepare("SELECT alias FROM opencode_key_rotator_active WHERE integration_id = 'openai'").get().alias, "default");
  db.close();
});

test("migrates OpenAI legacy OAuth using the browser method", () => {
  const dir = dataDir();
  writeJson(path.join(dir, "keys", "openai", "personal.json"), {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  });

  const report = migrateLegacy({ dataDir: dir });

  assert.equal(report.createdCredential, true);
  const db = openDb(dir);
  const credential = JSON.parse(db.prepare("SELECT value FROM credential WHERE integration_id = 'openai'").get().value);
  assert.equal(credential.type, "oauth");
  assert.equal(credential.methodID, "chatgpt-browser");
  db.close();
});

test("dry-run reports imports without writing database rows", () => {
  const dir = dataDir();
  writeJson(path.join(dir, "keys", "openai", "work.json"), { type: "api", key: "work-key" });

  const report = migrateLegacy({ dataDir: dir, dryRun: true });

  assert.equal(report.dryRun, true);
  assert.deepEqual(report.imported, ["openai/work"]);
  const db = openDb(dir);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM credential").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_key_rotator_alias").get().count, 0);
  db.close();
});

test("preserves existing v2 credentials as aliases", () => {
  const dir = dataDir();
  createCredentialTable(dir);
  const db = openDb(dir);
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)").run(
    "credential-existing",
    "openai",
    "current",
    JSON.stringify({ type: "key", key: "current-key" }),
    1,
    1,
  );
  db.close();

  const report = migrateLegacy({ dataDir: dir });

  assert.deepEqual(report.imported, ["openai/current"]);
  assert.equal(report.createdCredential, false);
  const migrated = openDb(dir);
  assert.equal(migrated.prepare("SELECT alias FROM opencode_key_rotator_active WHERE integration_id = 'openai'").get().alias, "current");
  migrated.close();
});

test("renames conflicting legacy aliases", () => {
  const dir = dataDir();
  createCredentialTable(dir);
  const db = openDb(dir);
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)").run(
    "credential-existing",
    "openai",
    "work",
    JSON.stringify({ type: "key", key: "current-key" }),
    1,
    1,
  );
  db.close();
  writeJson(path.join(dir, "keys", "openai", "work.json"), { type: "api", key: "legacy-key" });

  const report = migrateLegacy({ dataDir: dir });

  const migrated = openDb(dir);
  const aliases = migrated.prepare("SELECT alias FROM opencode_key_rotator_alias WHERE integration_id = 'openai' ORDER BY alias").all();
  assert.deepEqual(
    aliases.map((row) => row.alias),
    ["work", "work (legacy)"],
  );
  migrated.close();
});

test("fails clearly when migration has no importable credential", () => {
  const dir = dataDir();
  writeJson(path.join(dir, "keys", "openai", "broken.json"), { type: "oauth", access: "missing-refresh" });

  assert.throws(() => migrateLegacy({ dataDir: dir }), { code: "MIGRATION_EMPTY" });
});

test("ignores reserved backups directories", () => {
  const dir = dataDir();
  writeJson(path.join(dir, "keys", "backups", "ignored.json"), { type: "api", key: "must-not-import" });
  writeJson(path.join(dir, "keys", "openai", "work.json"), { type: "api", key: "work-key" });

  migrateLegacy({ dataDir: dir });

  const db = openDb(dir);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM opencode_key_rotator_alias WHERE integration_id = 'backups'").get().count, 0);
  db.close();
});

test("reports unsupported OAuth integrations", () => {
  const dir = dataDir();
  writeJson(path.join(dir, "keys", "github-copilot", "work.json"), {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  });

  assert.throws(
    () => migrateLegacy({ dataDir: dir }),
    (error) => error.code === "MIGRATION_EMPTY" && /unsupported OAuth integration: no v2 methodID adapter/.test(error.message),
  );
});
