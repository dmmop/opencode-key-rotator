import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { updateOpenCodeConfigs } from "../dist/config-installer.js";

test("init adds plugin to opencode config idempotently", () => {
  const configDir = tempConfigDir();
  const opencodeFile = path.join(configDir, "opencode.json");
  fs.writeFileSync(
    opencodeFile,
    `{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "existing-plugin",
  ],
}
`,
  );

  updateOpenCodeConfigs({ action: "init", configDir });
  updateOpenCodeConfigs({ action: "init", configDir });

  const content = fs.readFileSync(opencodeFile, "utf8");
  assert.match(content, /keep this comment/);
  assert.equal(countOccurrences(content, "opencode-key-rotator"), 1);
  assert.match(content, /existing-plugin/);
});

test("init preserves an existing key-rotator config", () => {
  const configDir = tempConfigDir();
  const configFile = path.join(configDir, "opencode-key-rotator", "config.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '{"rotation":{"enabled":false}}\n');

  const results = updateOpenCodeConfigs({ action: "init", configDir });

  assert.equal(fs.readFileSync(configFile, "utf8"), '{"rotation":{"enabled":false}}\n');
  assert.equal(results.find((result) => result.kind === "key-rotator").changed, false);
});

test("init uses plugins field for new OpenCode V2 config", () => {
  const configDir = tempConfigDir();
  const opencodeFile = path.join(configDir, "opencode.json");

  updateOpenCodeConfigs({ action: "init", configDir });

  const config = JSON.parse(fs.readFileSync(opencodeFile, "utf8"));
  assert.deepEqual(config.plugins, ["opencode-key-rotator"]);
  assert.equal(config.plugin, undefined);
});

test("uninstall deletes only the target plugin from opencode config", () => {
  const configDir = tempConfigDir();
  const opencodeFile = path.join(configDir, "opencode.json");
  fs.writeFileSync(
    opencodeFile,
    `{
  "plugins": ["existing-plugin", "opencode-key-rotator"]
}
`,
  );

  updateOpenCodeConfigs({ action: "uninstall", configDir });

  assert.match(fs.readFileSync(opencodeFile, "utf8"), /existing-plugin/);
  assert.doesNotMatch(fs.readFileSync(opencodeFile, "utf8"), /opencode-key-rotator/);
});

test("default config directory follows XDG_CONFIG_HOME", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-xdg-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = base;
  try {
    const results = updateOpenCodeConfigs({ action: "init" });
    assert.deepEqual(
      results.map((result) => result.path),
      [path.join(base, "opencode", "opencode.json"), path.join(base, "opencode", "opencode-key-rotator", "config.json")],
    );
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  }
});

function tempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-config-"));
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}
