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

test("session.error with statusCode 429 rotates key", async () => {
  const { dataDir } = tempDataDir();
  setupStore(dataDir, "openai");

  const { event } = await getEventHandler(dataDir);
  await event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-2",
        error: { name: "ProviderError", data: { providerID: "openai", statusCode: 429, message: "too many requests" } },
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

test("duplicate sessionID does not rotate twice", async () => {
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
