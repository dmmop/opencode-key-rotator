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

test("creates alias tables when the migration version is absent", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);

  store.saveCurrentProviderKey("openai", "primary", true);

  const db = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes("opencode_key_rotator_alias"));
  assert.ok(tables.includes("opencode_key_rotator_active"));
  db.close();
});

test("switch preserves the OpenCode connection label and updates active metadata", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("openai", "one", true);
  const db = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  db.prepare("UPDATE credential SET connector_id = ?, method_id = ?, active = ? WHERE id = ?").run("connector", "method", 1, "cred_one");
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)").run(
    "cred_older",
    "openai",
    "Older connection",
    JSON.stringify({ type: "key", key: "older" }),
    0,
    0,
  );
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
  const credential = check.prepare("SELECT connector_id, method_id, active FROM credential WHERE id = 'cred_one'").get();
  assert.equal(credential.connector_id, "connector");
  assert.equal(credential.method_id, "method");
  assert.equal(credential.active, 1);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM credential WHERE integration_id = 'openai'").get().count, 2);
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

test("status reports stale active metadata without deleting it", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("openai", "one", true);
  const db = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  db.prepare("UPDATE credential SET value = ? WHERE integration_id = ?").run(JSON.stringify({ type: "key", key: "changed" }), "openai");
  db.close();

  const status = store.getStatuses()[0];
  assert.equal(status.activeAlias, "one");
  assert.equal(status.synced, false);

  const check = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM opencode_key_rotator_active").get().count, 1);
  check.close();
});

test("rename rejects a missing source alias", () => {
  const store = createKeyStore(fixture());
  assert.throws(() => store.renameProviderKey("openai", "missing", "renamed"), { code: "NOT_CONNECTED" });
});

test("automatic rotation preserves the previous alias and active credential row", () => {
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

  assert.deepEqual(store.switchProviderKeyToNext("openai", ["two"]), {
    providerID: "openai",
    previousAlias: "one",
    activeAlias: "two",
  });

  const check = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  assert.equal(
    check.prepare("SELECT value FROM credential WHERE id = 'cred_one'").get().value,
    JSON.stringify({ type: "key", key: "two" }),
  );
  assert.equal(
    check.prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?").get("openai", "one").value,
    JSON.stringify({ type: "key", key: "one" }),
  );
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM credential WHERE integration_id = 'openai'").get().count, 1);
  check.close();
});

test("switch preserves refreshed OAuth credentials after OpenCode replaces the credential row", () => {
  const dataDir = fixture();
  const store = createKeyStore(dataDir);
  const initial = {
    type: "oauth",
    methodID: "chatgpt-browser",
    refresh: "old-refresh",
    access: "old-access",
    expires: 1,
    metadata: { accountID: "account-personal" },
  };
  const refreshed = {
    ...initial,
    refresh: "new-refresh",
    access: "new-access",
    expires: 2,
  };
  const other = {
    ...initial,
    refresh: "other-refresh",
    access: "other-access",
    metadata: { accountID: "account-other" },
  };
  const db = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  db.prepare("UPDATE credential SET value = ? WHERE id = ?").run(JSON.stringify(initial), "cred_one");
  db.close();
  store.saveCurrentProviderKey("openai", "personal", true);

  const replaced = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  replaced.prepare("DELETE FROM credential WHERE id = ?").run("cred_one");
  replaced
    .prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)")
    .run("cred_refreshed", "openai", "default", JSON.stringify(refreshed), 2, 2);
  replaced.prepare("INSERT INTO opencode_key_rotator_alias VALUES (?, ?, ?, ?, ?)").run("openai", "other", JSON.stringify(other), 2, 2);
  replaced.close();

  assert.equal(store.getStatuses()[0].activeAlias, "personal");
  assert.deepEqual(store.switchProviderKey("openai", "other"), {
    providerID: "openai",
    previousAlias: "personal",
    activeAlias: "other",
  });

  const check = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  assert.deepEqual(
    JSON.parse(
      check.prepare("SELECT value FROM opencode_key_rotator_alias WHERE integration_id = ? AND alias = ?").get("openai", "personal").value,
    ),
    refreshed,
  );
  check.close();
});
