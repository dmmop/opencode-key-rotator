import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createKeyStore } from "../dist/key-store.js";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-"));
  const db = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT NULL, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT NULL, method_id TEXT NULL, active INTEGER NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)").run(
    "cred_one",
    "openai",
    "Connection",
    JSON.stringify({ type: "key", key: "one" }),
    1,
    1,
  );
  db.close();
  return dataDir;
}

test("uses opencode-next.db and stores aliases in namespaced tables", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("openai", "primary", true);
  assert.equal(fs.existsSync(path.join(dataDir, "opencode-next.db")), true);
  assert.deepEqual(store.getStatuses()[0].aliases, ["primary"]);
  assert.equal(store.getStatuses()[0].activeAlias, "primary");
});

test("switch preserves the OpenCode connection label and updates active metadata", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("openai", "one", true);
  const db = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  db.prepare("INSERT INTO opencode_key_rotator_alias VALUES (?, ?, ?, ?, ?)").run(
    "openai",
    "two",
    JSON.stringify({ type: "key", key: "two" }),
    2,
    2,
  );
  db.close();
  store.switchProviderKey("openai", "two");
  const check = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  assert.equal(check.prepare("SELECT label FROM credential WHERE integration_id = 'openai'").get().label, "Connection");
  assert.equal(store.readActiveAliases().openai, "two");
  check.close();
});

test("active aliases cannot be deleted and alias collisions are rejected", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("openai", "one", true);
  assert.throws(() => store.deleteProviderKey("openai", "one"), { code: "ACTIVE_ALIAS" });
  assert.throws(() => store.renameProviderKey("openai", "one", "one"), { code: "ALIAS_COLLISION" });
});

test("rejects a busy lock and accepts a stale lock", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);
  fs.mkdirSync(path.join(dataDir, "keys"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "keys", ".lock"), "{}");
  assert.throws(() => store.saveCurrentProviderKey("openai", "one", true), /busy/i);
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dataDir, "keys", ".lock"), stale, stale);
  assert.doesNotThrow(() => store.saveCurrentProviderKey("openai", "one", true));
});
