import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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

test("init creates opencode.json and key-rotator config when missing", () => {
  const configDir = tempConfigDir();
  const { stdout, exitCode } = runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /Added/);
  assert.equal(fs.existsSync(path.join(configDir, "opencode.json")), true);

  const keyRotatorConfigFile = path.join(configDir, "opencode-key-rotator", "config.json");
  assert.equal(fs.existsSync(keyRotatorConfigFile), true);
  const keyRotatorConfig = JSON.parse(fs.readFileSync(keyRotatorConfigFile, "utf8"));
  assert.equal(keyRotatorConfig.ui.toastDurationMs, 11_000);

  const opencodeConfig = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
  assert.ok(opencodeConfig.plugins.includes("opencode-key-rotator"));
});

test("init is idempotent", () => {
  const configDir = tempConfigDir();
  runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });
  const { stdout, exitCode } = runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /already includes/);
});

test("remove deletes plugin from configs", () => {
  const configDir = tempConfigDir();
  runBin(["init"], { OPENCODE_CONFIG_DIR: configDir });
  const { stdout, exitCode } = runBin(["remove"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /Removed/);
  const opencodeConfig = JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"));
  assert.equal(opencodeConfig.plugins, undefined);
});

test("remove is idempotent", () => {
  const configDir = tempConfigDir();
  const { stdout, exitCode } = runBin(["remove"], { OPENCODE_CONFIG_DIR: configDir });

  assert.equal(exitCode, 0);
  assert.match(stdout, /did not include/);
});

test("--help shows usage", () => {
  const { stdout, exitCode } = runBin(["--help"]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /Usage/);
  assert.match(stdout, /opencode-key-rotator init/);
});

test("no arguments exits with error and shows help", () => {
  const { stdout, exitCode } = runBin([]);
  assert.notEqual(exitCode, 0);
  assert.match(stdout, /Usage/);
});
