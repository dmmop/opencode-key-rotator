import assert from "node:assert/strict";
import test from "node:test";
import plugin from "opencode-key-rotator/tui";

test("V2 TUI plugin registers local key commands", async () => {
  let layer;
  await plugin.tui({
    keymap: {
      registerLayer(value) {
        layer = value;
      },
    },
  });

  const commands = layer.commands;
  assert.deepEqual(
    commands.map((command) => command.slashName),
    ["key-save", "key-switch", "key-status"],
  );
  assert.deepEqual(
    commands.map((command) => command.name),
    ["key_rotator.save", "key_rotator.switch", "key_rotator.status"],
  );
  assert.ok(commands.every((command) => command.namespace === "palette"));
  assert.ok(commands.every((command) => typeof command.run === "function"));
});
