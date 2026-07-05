import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createKeyStore } from "../dist/key-store.js";
import { server } from "../dist/server.js";

function tempDataDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-"));
  process.env.HOME = base;
  const dataHome = path.join(base, "data");
  const configHome = path.join(base, "config");
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_CONFIG_HOME = configHome;
  return {
    base,
    dataDir: path.join(dataHome, "opencode"),
    configDir: path.join(configHome, "opencode"),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function createMockClient(dataDir, overrides = {}) {
  return {
    path: {
      get: async () => ({ data: { state: dataDir, data: dataDir } }),
    },
    config: {
      get: async () => ({ data: { model: "openai/gpt-4" } }),
    },
    session: {
      prompt: async () => {},
      messages: async () => ({ data: [] }),
    },
    tui: {
      showToast: async () => {},
    },
    ...overrides,
  };
}

function setupStore(dataDir, providerID) {
  writeJson(path.join(dataDir, "auth.json"), {
    [providerID]: { type: "api", key: "primary-key" },
  });

  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey(providerID, "primary", true);
  fs.mkdirSync(path.join(dataDir, "keys", providerID), { recursive: true });
  writeJson(path.join(dataDir, "keys", providerID, "secondary.json"), { type: "api", key: "secondary-key" });

  return store;
}

function addProviderKey(dataDir, providerID, alias, key) {
  fs.mkdirSync(path.join(dataDir, "keys", providerID), { recursive: true });
  writeJson(path.join(dataDir, "keys", providerID, `${alias}.json`), { type: "api", key });
}

async function getEventHandler(dataDir, overrides = {}) {
  const client = createMockClient(dataDir, overrides);
  const plugin = await server({ client });
  return { client, event: plugin.event };
}

function lastLogEntry(dataDir) {
  const logFile = path.join(dataDir, "keys", "rotation.log.jsonl");
  const logLines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(logLines[logLines.length - 1]);
}

function logEntries(dataDir) {
  const logFile = path.join(dataDir, "keys", "rotation.log.jsonl");
  return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("server initialization falls back when path lookup hangs", async () => {
  const { dataDir } = tempDataDir();
  const client = createMockClient(dataDir, {
    path: { get: async () => new Promise(() => {}) },
  });

  const start = Date.now();
  const plugin = await server({ client });

  assert.equal(typeof plugin.event, "function");
  assert.ok(Date.now() - start < 1_500);
});

test("session.next.retried with attempt=1 and rotatable message rotates key", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.next.retried",
      properties: { sessionID: "session-1", attempt: 1, error: { message: "rate limit exceeded" } },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "secondary-key");
});

test("session.status retry with attempt=1 and rotatable message rotates key", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.status",
      properties: {
        sessionID: "session-status-1",
        status: { type: "retry", attempt: 1, message: "The usage limit has been reached", next: Date.now() + 1_000 },
      },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "secondary-key");

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "rotated_on_retry");
  assert.equal(entry.eventType, "session.status");
});

test("session.error with statusCode 429 rotates key", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-2",
        error: { name: "ProviderError", data: { providerID: "openai", statusCode: 429, message: "rate limit" } },
      },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "secondary-key");
});

test("MessageAbortedError is logged as manual_abort and does not rotate", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.error",
      properties: { sessionID: "session-3", error: { name: "MessageAbortedError", message: "aborted" } },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "primary-key");

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "ignored");
  assert.equal(entry.reason, "manual_abort");
});

test("same session rotates until no provider keys are available", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  const eventPayload = {
    event: {
      type: "session.next.retried",
      properties: { sessionID: "session-4", attempt: 1, error: { message: "rate limit" } },
    },
  };

  await event(eventPayload);
  await event(eventPayload);

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "secondary-key");

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "all_keys_cooling_down");
  assert.equal(entry.activeAlias, "secondary");
});

test("session.next.retried with attempt !== 1 does not rotate", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.next.retried",
      properties: { sessionID: "session-5", attempt: 2, error: { message: "rate limit" } },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "primary-key");
});

test("session.next.retried logs diagnostics for unmatched payloads", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.next.retried",
      properties: { sessionID: "session-diagnostic", attempt: 1, error: { name: "ProviderError", details: "usage capped" } },
    },
  });

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "diagnostic");
  assert.equal(entry.reason, "retry_error_did_not_match_rotation_patterns");
  assert.equal(entry.eventType, "session.next.retried");
  assert.equal(entry.sessionID, "session-diagnostic");
  assert.equal(entry.attempt, 1);
  assert.deepEqual(entry.propertyKeys, ["attempt", "error", "sessionID"]);
  assert.deepEqual(entry.errorKeys, ["details", "name"]);
});

test("same session can rotate through a third provider key", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");
  addProviderKey(dataDir, "openai", "tertiary", "tertiary-key");

  const { event } = await getEventHandler(dataDir);
  const eventPayload = {
    event: {
      type: "session.next.retried",
      properties: { sessionID: "session-dedup-diagnostic", attempt: 1, error: { message: "rate limit" } },
    },
  };

  await event(eventPayload);
  await event(eventPayload);

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "tertiary-key");

  const entries = logEntries(dataDir);
  assert.equal(entries.at(-1).decision, "rotated_on_retry");
  assert.equal(entries.at(-1).activeAlias, "secondary");
  assert.equal(entries.at(-1).nextAlias, "tertiary");
});

test("unhandled events are logged for diagnostics", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.provider.failed",
      properties: {
        sessionID: "session-unhandled",
        attempt: 3,
        error: { name: "ProviderError", message: "The usage limit has been reached", data: { statusCode: 429 } },
      },
    },
  });

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "diagnostic");
  assert.equal(entry.reason, "unhandled_event");
  assert.equal(entry.eventType, "session.provider.failed");
  assert.equal(entry.sessionID, "session-unhandled");
  assert.equal(entry.attempt, 3);
  assert.deepEqual(entry.propertyKeys, ["attempt", "error", "sessionID"]);
  assert.deepEqual(entry.errorKeys, ["data", "message", "name"]);
  assert.deepEqual(entry.errorDataKeys, ["statusCode"]);
  assert.equal(entry.message, "The usage limit has been reached");
  assert.deepEqual(entry.payload, {
    attempt: 3,
    error: {
      data: { statusCode: 429 },
      message: "The usage limit has been reached",
      name: "ProviderError",
    },
    sessionID: "session-unhandled",
  });
});

test("unknown provider logs provider_unknown and does not rotate", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir, {
    config: { get: async () => ({ data: {} }) },
  });
  await event({
    event: {
      type: "session.error",
      properties: { sessionID: "session-6", error: { name: "Error", data: { statusCode: 429, message: "rate limit" } } },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth.openai.key, "primary-key");

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "provider_unknown");
});

test("provider with less than two saved keys logs no_alternative", async () => {
  const { dataDir } = tempDataDir();
  const providerID = "openai";
  writeJson(path.join(dataDir, "auth.json"), {
    [providerID]: { type: "api", key: "only-key" },
  });
  const store = createKeyStore(dataDir);
  store.saveCurrentProviderKey(providerID, "only", true);

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-7",
        error: { name: "ProviderError", data: { providerID, statusCode: 429, message: "rate limit" } },
      },
    },
  });

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "no_alternative");
});

test("all recently failed provider keys stop automatic rotation", async () => {
  const { dataDir } = tempDataDir();
  const providerID = "cooldown_openai";
  setupStore(dataDir, providerID);

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "cooldown-session-1",
        error: { name: "ProviderError", data: { providerID, statusCode: 429, message: "rate limit" } },
      },
    },
  });
  await event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "cooldown-session-2",
        error: { name: "ProviderError", data: { providerID, statusCode: 429, message: "rate limit" } },
      },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth[providerID].key, "secondary-key");

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "all_keys_cooling_down");
  assert.equal(entry.reason, "all_saved_keys_are_cooling_down");
  assert.equal(entry.activeAlias, "secondary");
});

test("automatic rotation skips cooling aliases when another key is available", async () => {
  const { dataDir } = tempDataDir();
  const providerID = "cooldown_three_openai";
  setupStore(dataDir, providerID);
  addProviderKey(dataDir, providerID, "tertiary", "tertiary-key");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "cooldown-three-session-1",
        error: { name: "ProviderError", data: { providerID, statusCode: 429, message: "rate limit" } },
      },
    },
  });
  await event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "cooldown-three-session-2",
        error: { name: "ProviderError", data: { providerID, statusCode: 429, message: "rate limit" } },
      },
    },
  });

  const auth = readJson(path.join(dataDir, "auth.json"));
  assert.equal(auth[providerID].key, "tertiary-key");

  const entry = lastLogEntry(dataDir);
  assert.equal(entry.decision, "rotated");
  assert.equal(entry.activeAlias, "secondary");
  assert.equal(entry.nextAlias, "tertiary");
});
