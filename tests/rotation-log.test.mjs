import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createKeyStore } from "../dist/key-store.js";
import { readLastRotationDecision, writeRotationLog } from "../dist/rotation-log.js";

test("last rotation decision skips manual abort traces", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-log-"));
  const store = createKeyStore(dataDir);

  writeRotationLog(store, {
    timestamp: "2026-01-01T00:00:00.000Z",
    providerID: "openai",
    decision: "rotated",
    reason: "matched_rotation_patterns",
    activeAlias: "personal",
    nextAlias: "work",
  });
  writeRotationLog(store, {
    timestamp: "2026-01-01T00:01:00.000Z",
    decision: "ignored",
    reason: "manual_abort",
  });

  const lastDecision = readLastRotationDecision(store);
  assert.equal(lastDecision?.decision, "rotated");
  assert.equal(lastDecision?.providerID, "openai");
});

test("rotation log rolls over at 50 MiB", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-log-"));
  const store = createKeyStore(dataDir);
  store.ensureKeysDir();

  fs.writeFileSync(store.paths.rotationLogFile, "");
  fs.truncateSync(store.paths.rotationLogFile, 50 * 1024 * 1024);

  writeRotationLog(store, {
    timestamp: "2026-01-01T00:00:00.000Z",
    providerID: "openai",
    decision: "rotated",
    reason: "matched_rotation_patterns",
  });

  const logDir = path.dirname(store.paths.rotationLogFile);
  const rotatedLogs = fs.readdirSync(logDir).filter((name) => /^rotation\.log\.\d{8}T\d{6}Z\.jsonl$/.test(name));

  assert.equal(rotatedLogs.length, 1);
  assert.ok(fs.statSync(store.paths.rotationLogFile).size < 1024);
  assert.equal(readLastRotationDecision(store)?.decision, "rotated");
});
