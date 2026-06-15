import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadConfig, DEFAULT_ROTATION_PATTERNS } from "../dist/config.js";

function tempConfigDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-config-"));
  process.env.HOME = base;
  const configHome = path.join(base, "config");
  process.env.XDG_CONFIG_HOME = configHome;
  return path.join(configHome, "opencode");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("loadConfig returns defaults when config file does not exist", () => {
  const configDir = tempConfigDir();
  const config = loadConfig({ configDir });

  assert.equal(config.rotation.enabled, true);
  assert.equal(config.rotation.dedupTtlMs, 5 * 60 * 1000);
  assert.equal(config.storage.maxBackups, 10);
  assert.equal(config.storage.lockTtlMs, 30_000);
  assert.equal(config.ui.toastDurationMs, 11_000);
  assert.equal(config.rotation.patterns.length, DEFAULT_ROTATION_PATTERNS.length);
});

test("loadConfig merges partial config with defaults", () => {
  const configDir = tempConfigDir();
  writeJson(path.join(configDir, "opencode-key-rotator", "config.json"), {
    storage: { maxBackups: 5 },
    ui: { toastDurationMs: 3_000 },
  });

  const config = loadConfig({ configDir });
  assert.equal(config.storage.maxBackups, 5);
  assert.equal(config.storage.lockTtlMs, 30_000);
  assert.equal(config.ui.toastDurationMs, 3_000);
  assert.equal(config.rotation.dedupTtlMs, 5 * 60 * 1000);
});

test("loadConfig parses custom rotation patterns", () => {
  const configDir = tempConfigDir();
  writeJson(path.join(configDir, "opencode-key-rotator", "config.json"), {
    rotation: { patterns: ["custom pattern"] },
  });

  const config = loadConfig({ configDir });
  assert.equal(config.rotation.patterns.length, 1);
  assert.equal(config.rotation.patterns[0].test("CUSTOM PATTERN"), true);
});

test("loadConfig respects OPENCODE_KEY_ROTATOR_CONFIG env var", () => {
  const configFile = path.join(os.tmpdir(), `key-rotator-config-${Date.now()}.json`);
  writeJson(configFile, { rotation: { enabled: false } });
  process.env.OPENCODE_KEY_ROTATOR_CONFIG = configFile;

  const config = loadConfig();
  assert.equal(config.rotation.enabled, false);

  delete process.env.OPENCODE_KEY_ROTATOR_CONFIG;
  fs.rmSync(configFile);
});

test("loadConfig supports JSONC comments and trailing commas", () => {
  const configDir = tempConfigDir();
  fs.mkdirSync(path.join(configDir, "opencode-key-rotator"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "opencode-key-rotator", "config.json"),
    `{
      // Disable automatic rotation
      "rotation": {
        "enabled": false,
      },
    }`,
  );

  const config = loadConfig({ configDir });
  assert.equal(config.rotation.enabled, false);
});

test("loadConfig throws on invalid regex pattern", () => {
  const configDir = tempConfigDir();
  writeJson(path.join(configDir, "opencode-key-rotator", "config.json"), {
    rotation: { patterns: ["[invalid"] },
  });

  assert.throws(() => loadConfig({ configDir }), /not a valid regex/);
});

test("loadConfig throws on negative maxBackups", () => {
  const configDir = tempConfigDir();
  writeJson(path.join(configDir, "opencode-key-rotator", "config.json"), {
    storage: { maxBackups: -1 },
  });

  assert.throws(() => loadConfig({ configDir }), /non-negative integer/);
});

test("loadConfig throws on invalid dedupTtlMs", () => {
  const configDir = tempConfigDir();
  writeJson(path.join(configDir, "opencode-key-rotator", "config.json"), {
    rotation: { dedupTtlMs: 0 },
  });

  assert.throws(() => loadConfig({ configDir }), /positive number/);
});
