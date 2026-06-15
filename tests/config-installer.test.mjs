import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { updateOpenCodeConfigs } from "../dist/config-installer.js"

test("init adds plugin to JSONC configs idempotently", () => {
  const configDir = tempConfigDir()
  const opencodeFile = path.join(configDir, "opencode.json")
  fs.writeFileSync(opencodeFile, `{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "existing-plugin",
  ],
}
`)

  updateOpenCodeConfigs({ action: "init", spec: "opencode-key-rotator", configDir })
  updateOpenCodeConfigs({ action: "init", spec: "opencode-key-rotator", configDir })

  const content = fs.readFileSync(opencodeFile, "utf8")
  assert.match(content, /keep this comment/)
  assert.equal(countOccurrences(content, "opencode-key-rotator"), 1)
  assert.match(content, /existing-plugin/)
})

test("remove deletes only the target plugin and removes empty plugin property", () => {
  const configDir = tempConfigDir()
  const opencodeFile = path.join(configDir, "opencode.json")
  const tuiFile = path.join(configDir, "tui.json")
  fs.writeFileSync(opencodeFile, `{
  "plugin": ["existing-plugin", "opencode-key-rotator"]
}
`)
  fs.writeFileSync(tuiFile, `{
  "plugin": ["opencode-key-rotator"]
}
`)

  updateOpenCodeConfigs({ action: "remove", spec: "opencode-key-rotator", configDir })

  assert.match(fs.readFileSync(opencodeFile, "utf8"), /existing-plugin/)
  assert.doesNotMatch(fs.readFileSync(opencodeFile, "utf8"), /opencode-key-rotator/)
  assert.doesNotMatch(fs.readFileSync(tuiFile, "utf8"), /"plugin"/)
})

function tempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-key-rotator-config-"))
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1
}
