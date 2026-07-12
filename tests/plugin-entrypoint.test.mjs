import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../dist/index.js";

test("default entrypoint exports an OpenCode v2 plugin", () => {
  assert.equal(plugin.id, "opencode-key-rotator");
  assert.equal(typeof plugin.setup, "function");
  assert.deepEqual(Object.keys(plugin).sort(), ["id", "setup"]);
});
