import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createKeyStore } from "../dist/key-store.js";

test("stores keys under provider directories and preserves other auth providers", () => {
  const { dataDir } = tempDataDir();
  writeJson(path.join(dataDir, "auth.json"), {
    open_ai: { type: "api", key: "key-provider-with-underscore" },
    openai: { type: "api", key: "key-a" },
    anthropic: { type: "api", key: "anthropic-key" },
  });

  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("open_ai", "personal_key", true);
  assert.equal(fs.existsSync(path.join(dataDir, "keys", "open_ai", "personal_key.json")), true);

  writeJson(path.join(dataDir, "auth.json"), {
    openai: { type: "api", key: "key-b" },
    open_ai: { type: "api", key: "key-a" },
    anthropic: { type: "api", key: "anthropic-key" },
  });
  store.saveCurrentProviderKey("openai", "work", true);
  store.switchProviderKey("openai", "work");

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.deepEqual(auth.anthropic, { type: "api", key: "anthropic-key" });
  assert.deepEqual(auth.openai, { type: "api", key: "key-b" });
});

test("status comes from keys and active metadata when auth is missing", () => {
  const { dataDir } = tempDataDir();
  const store = createKeyStore(dataDir);
  fs.mkdirSync(path.join(dataDir, "keys", "open_ai"), { recursive: true });
  writeJson(path.join(dataDir, "keys", "open_ai", "personal_key.json"), { type: "api", key: "key-a" });

  const statuses = store.getStatuses();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].providerID, "open_ai");
  assert.deepEqual(statuses[0].aliases, ["personal_key"]);
});

test("switch is blocked when active credentials changed outside the plugin", () => {
  const { dataDir } = tempDataDir();
  const authFile = path.join(dataDir, "auth.json");
  writeJson(authFile, { openai: { type: "api", key: "key-a" } });

  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("openai", "a", true);
  writeJson(authFile, { openai: { type: "api", key: "key-b" } });
  store.saveCurrentProviderKey("openai", "b", false);
  writeJson(authFile, { openai: { type: "api", key: "changed-outside" } });

  assert.throws(() => store.switchProviderKey("openai", "b"), /no longer match alias/);
});

test("lockfile blocks concurrent writes unless stale", () => {
  const { dataDir } = tempDataDir();
  const store = createKeyStore(dataDir);
  writeJson(path.join(dataDir, "auth.json"), { openai: { type: "api", key: "key-a" } });
  fs.mkdirSync(path.join(dataDir, "keys"), { recursive: true });
  const lockFile = path.join(dataDir, "keys", ".lock");
  fs.writeFileSync(lockFile, "{}");

  assert.throws(() => store.saveCurrentProviderKey("openai", "a", true), /busy/);

  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, stale, stale);
  assert.doesNotThrow(() => store.saveCurrentProviderKey("openai", "a", true));
});

test("api key fingerprints are stable", () => {
  const { dataDir } = tempDataDir();
  writeJson(path.join(dataDir, "auth.json"), { "opencode-go": { type: "api", key: "key-a" } });

  const store = createKeyStore(dataDir);
  const saved = store.saveCurrentProviderKey("opencode-go", "davidmtn", true);

  assert.equal(saved.fingerprint.type, "api");
  assert.equal(saved.fingerprint.stability, "stable");
});

test("reads auth.json from XDG data dir and keeps keys in the same data dir", () => {
  const { dataDir } = tempDataDir();
  writeJson(path.join(dataDir, "auth.json"), { openai: { type: "api", key: "key-a" } });

  const store = createKeyStore(dataDir);
  assert.equal(store.paths.dataDir, dataDir);
  assert.equal(store.paths.authFile, path.join(dataDir, "auth.json"));

  store.saveCurrentProviderKey("openai", "personal", true);
  assert.equal(fs.existsSync(path.join(dataDir, "keys", "openai", "personal.json")), true);
});

test("auth backups are unique when created with the same timestamp", () => {
  const { dataDir } = tempDataDir();
  writeJson(path.join(dataDir, "auth.json"), { openai: { type: "api", key: "key-a" } });
  const store = createKeyStore(dataDir);
  const RealDate = globalThis.Date;

  try {
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length > 0 ? args : ["2026-06-22T06:30:27.148Z"]));
      }

      static now() {
        return new RealDate("2026-06-22T06:30:27.148Z").getTime();
      }
    };

    const first = store.backupAuth("auto-rotate");
    const second = store.backupAuth("auto-rotate");

    assert.notEqual(first, second);
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);
  } finally {
    globalThis.Date = RealDate;
  }
});

function tempDataDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-"));
  // Isolate from the real home directory so XDG fallback candidates do not
  // accidentally pick up the user's actual OpenCode auth.json during tests.
  process.env.HOME = base;
  const dataHome = path.join(base, "data");
  process.env.XDG_DATA_HOME = dataHome;
  return {
    base,
    dataDir: path.join(dataHome, "opencode"),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
