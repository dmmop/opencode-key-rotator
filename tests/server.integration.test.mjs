import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { createKeyStore } from "../dist/key-store.js";
import { handleEvent } from "../dist/server.js";

function fixture(aliasValues = { primary: "primary", secondary: "secondary" }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-"));
  const dataDir = path.join(base, "data", "opencode");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbFile = path.join(dataDir, "opencode-next.db");
  const db = new DatabaseSync(dbFile);
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT NULL, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT NULL, method_id TEXT NULL, active INTEGER NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)").run(
    "credential-primary",
    "openai",
    "primary",
    JSON.stringify({ type: "key", key: aliasValues.primary }),
    1,
    1,
  );
  db.close();

  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey("openai", "primary", true);

  const aliases = new DatabaseSync(dbFile);
  for (const [alias, key] of Object.entries(aliasValues)) {
    if (alias === "primary") continue;
    aliases.prepare("INSERT INTO opencode_key_rotator_alias VALUES (?, ?, ?, ?, ?)").run(
      "openai",
      alias,
      JSON.stringify({ type: "key", key }),
      2,
      2,
    );
  }
  aliases.close();

  return { base, dataDir };
}

function withDataHome(base, callback) {
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(base, "data");
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
    });
}

function currentKey(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "opencode-next.db"));
  const row = db.prepare("SELECT value FROM credential WHERE integration_id = ?").get("openai");
  db.close();
  return JSON.parse(row.value).key;
}

function logEntries(dataDir) {
  const file = path.join(dataDir, "keys", "rotation.log.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

const sessionCtx = (providerID = "openai") => ({
  session: {
    get: async () => ({ model: { providerID } }),
  },
});

function retryEvent(message = "Provider request failed with HTTP 429: usage_limit_reached") {
  return {
    type: "session.retry.scheduled",
    data: {
      sessionID: "session-1",
      assistantMessageID: "message-1",
      attempt: 4,
      at: Date.now(),
      error: { type: "provider.rate-limit", message },
    },
  };
}

test("session.retry.scheduled rotates to the next saved alias", async () => {
  const { base, dataDir } = fixture();
  await withDataHome(base, async () => {
    await handleEvent(sessionCtx(), loadConfig(), retryEvent());

    assert.equal(currentKey(dataDir), "secondary");
    const entries = logEntries(dataDir);
    assert.equal(entries.at(-2).decision, "diagnostic");
    assert.equal(entries.at(-2).reason, "alias_entered_cooldown");
    assert.equal(entries.at(-1).decision, "rotated_on_retry");
    assert.equal(entries.at(-1).activeAlias, "primary");
    assert.equal(entries.at(-1).nextAlias, "secondary");
  });
});

test("failure events with HTTP 429 rotate using provider from event data", async () => {
  const { base, dataDir } = fixture();
  await withDataHome(base, async () => {
    await handleEvent({ session: { get: async () => ({}) } }, loadConfig(), {
      type: "session.step.failed",
      data: {
        sessionID: "session-1",
        assistantMessageID: "message-1",
        providerID: "openai",
        error: { type: "provider.rate-limit", message: "Provider request failed with HTTP 429" },
      },
    });

    assert.equal(currentKey(dataDir), "secondary");
    assert.equal(logEntries(dataDir).at(-1).eventType, "session.step.failed");
  });
});

test("unknown provider is logged without changing credentials", async () => {
  const { base, dataDir } = fixture();
  await withDataHome(base, async () => {
    await handleEvent({ session: { get: async () => ({}) } }, loadConfig(), retryEvent());

    assert.equal(currentKey(dataDir), "primary");
    const entry = logEntries(dataDir).at(-1);
    assert.equal(entry.decision, "provider_unknown");
    assert.equal(entry.reason, "rotatable_retry_without_provider_id");
  });
});

test("non-rate-limit failures are diagnostic only", async () => {
  const { base, dataDir } = fixture();
  await withDataHome(base, async () => {
    await handleEvent(sessionCtx(), loadConfig(), {
      type: "session.execution.failed",
      data: {
        sessionID: "session-1",
        error: { type: "provider.invalid-request", message: "Provider request failed with HTTP 404: model not found" },
      },
    });

    assert.equal(currentKey(dataDir), "primary");
    const entry = logEntries(dataDir).at(-1);
    assert.equal(entry.decision, "diagnostic");
    assert.equal(entry.reason, "failure_error_did_not_match_rotation_patterns");
  });
});

test("cooldown skips aliases that just failed", async () => {
  const { base, dataDir } = fixture({ primary: "primary", secondary: "secondary", tertiary: "tertiary" });
  await withDataHome(base, async () => {
    await handleEvent(sessionCtx(), loadConfig(), retryEvent());
    await handleEvent(sessionCtx(), loadConfig(), retryEvent());

    assert.equal(currentKey(dataDir), "tertiary");
    const entry = logEntries(dataDir).at(-1);
    assert.equal(entry.decision, "rotated_on_retry");
    assert.equal(entry.activeAlias, "secondary");
    assert.equal(entry.nextAlias, "tertiary");
  });
});

test("all aliases in cooldown logs all_keys_cooling_down", async () => {
  const { base, dataDir } = fixture();
  await withDataHome(base, async () => {
    await handleEvent(sessionCtx(), loadConfig(), retryEvent());
    await handleEvent(sessionCtx(), loadConfig(), retryEvent());

    assert.equal(currentKey(dataDir), "secondary");
    const entry = logEntries(dataDir).at(-1);
    assert.equal(entry.decision, "all_keys_cooling_down");
    assert.equal(entry.reason, "all_saved_keys_are_cooling_down");
  });
});
