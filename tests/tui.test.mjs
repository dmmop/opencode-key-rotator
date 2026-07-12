import assert from "node:assert/strict";
import test from "node:test";
import plugin from "opencode-key-rotator/tui";

test("V1 TUI adapter registers local key commands", async () => {
  const commands = [];
  await plugin.tui({
    command: {
      register(factory) {
        commands.push(...factory());
      },
    },
  });

  assert.deepEqual(
    commands.map((command) => command.slash.name),
    ["key-save", "key-switch", "key-status"],
  );
  assert.ok(commands.every((command) => typeof command.onSelect === "function"));
});
