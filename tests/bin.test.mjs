import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");

function tempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-config-"));
}

function runBin(args, env = {}) {
  const result = spawnSync("node", [BIN_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function keyFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-keys-"));
  const dbFile = path.join(dataDir, "opencode-next.db");
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT NULL, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT NULL, method_id TEXT NULL, active INTEGER NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE opencode_key_rotator_migration (version INTEGER PRIMARY KEY, time_applied INTEGER NOT NULL);
    CREATE TABLE opencode_key_rotator_alias (integration_id TEXT NOT NULL, alias TEXT NOT NULL, value TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY (integration_id, alias));
    CREATE TABLE opencode_key_rotator_active (integration_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, alias TEXT NOT NULL, time_updated INTEGER NOT NULL, FOREIGN KEY (integration_id, alias) REFERENCES opencode_key_rotator_alias(integration_id, alias) ON UPDATE CASCADE ON DELETE RESTRICT);
  `);
  db.prepare("INSERT INTO opencode_key_rotator_migration VALUES (1, 1)").run();
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, 1)").run(
    "cred_primary",
    "openai",
    "OpenAI",
    JSON.stringify({ type: "key", key: "primary-key" }),
  );
  db.prepare("INSERT INTO opencode_key_rotator_alias VALUES (?, ?, ?, 1, 1)").run(
    "openai",
    "primary",
    JSON.stringify({ type: "key", key: "primary-key" }),
  );
  db.prepare("INSERT INTO opencode_key_rotator_alias VALUES (?, ?, ?, 1, 1)").run(
    "openai",
    "sepd",
    JSON.stringify({ type: "key", key: "sepd-key" }),
  );
  db.prepare("INSERT INTO opencode_key_rotator_active VALUES (?, ?, ?, 1)").run("openai", "cred_primary", "primary");
  db.close();
  return { dataDir, dbFile };
}

test("init creates opencode.json and key-rotator config when missing", () => {
  const configDir = tempConfigDir();
  const { stdout, exitCode } = runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /Added/);
  assert.equal(fs.existsSync(path.join(configDir, "opencode.json")), true);

  const keyRotatorConfigFile = path.join(configDir, "opencode-key-rotator", "config.json");
  assert.equal(fs.existsSync(keyRotatorConfigFile), true);
  const keyRotatorConfig = JSON.parse(fs.readFileSync(keyRotatorConfigFile, "utf8"));
  assert.equal(keyRotatorConfig.rotation.enabled, true);

  const opencodeConfig = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
  assert.ok(opencodeConfig.plugins.includes("opencode-key-rotator"));
});

test("init is idempotent", () => {
  const configDir = tempConfigDir();
  runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });
  const { stdout, exitCode } = runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /already installed/);
});

test("uninstall deletes plugin from configs", () => {
  const configDir = tempConfigDir();
  runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });
  const { stdout, exitCode } = runBin(["uninstall"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /Uninstalled/);
  const opencodeConfig = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
  assert.equal(opencodeConfig.plugins, undefined);
});

test("uninstall is idempotent", () => {
  const configDir = tempConfigDir();
  const { stdout, exitCode } = runBin(["uninstall"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /not installed/);
});

test("--help shows usage", () => {
  const { stdout, exitCode } = runBin(["--help"]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Usage/);
  assert.match(stdout, /opencode-key-rotator init/);
  assert.match(stdout, /opencode-key-rotator uninstall/);
  assert.match(stdout, /opencode-key-rotator manage/);
  assert.match(stdout, /opencode-key-rotator status/);
});

test("no arguments exits with error and shows help", () => {
  const { stdout, exitCode } = runBin([]);
  assert.notEqual(exitCode, 0);
  assert.match(stdout, /Usage/);
});

test("switch changes the active alias without a prompt when flags are provided", () => {
  const { dataDir, dbFile } = keyFixture();

  const { stdout, exitCode } = runBin(["switch", "--provider", "openai", "--alias", "sepd", "--data-dir", dataDir]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /openai: primary -> sepd/);
  const check = new DatabaseSync(dbFile);
  assert.equal(JSON.parse(check.prepare("SELECT value FROM credential WHERE integration_id = 'openai'").get().value).key, "sepd-key");
  check.close();
});

test("status shows aliases and the latest automatic rotation", () => {
  const { dataDir } = keyFixture();
  const keysDir = path.join(dataDir, "keys");
  fs.mkdirSync(keysDir);
  fs.writeFileSync(
    path.join(keysDir, "rotation.log.jsonl"),
    `${JSON.stringify({ timestamp: "2026-07-12T12:00:00.000Z", providerID: "openai", decision: "rotated", reason: "matched_rotation_patterns", activeAlias: "primary", nextAlias: "sepd" })}\n`,
  );

  const { stdout, exitCode } = runBin(["status", "--provider", "openai", "--data-dir", dataDir]);

  assert.equal(exitCode, 0);
  assert.match(stdout, /KEY ROTATOR STATUS/);
  assert.match(stdout, /openai\s+primary\s+2\s+✓ Ready/);
  assert.match(stdout, /aliases: primary, sepd/);
  assert.match(stdout, /LAST AUTOMATIC ROTATION/);
  assert.match(stdout, /✓ Rotated · openai/);
  assert.match(stdout, /primary\s+→\s+sepd/);
});

test("removed commands and --spec are rejected", () => {
  assert.notEqual(runBin(["remove"]).exitCode, 0);
  assert.notEqual(runBin(["migrate"]).exitCode, 0);
  assert.notEqual(runBin(["init", "--spec", "local"]).exitCode, 0);
});
