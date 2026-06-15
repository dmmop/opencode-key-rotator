import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser"
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js"

export type InstallerAction = "init" | "remove"

export type ConfigEditResult = {
  kind: "opencode" | "tui"
  path: string
  existed: boolean
  changed: boolean
  message: string
}

export type InstallOptions = {
  action: InstallerAction
  spec: string
  configDir?: string
}

const PACKAGE_NAME = "opencode-key-rotator"
const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json"
const TUI_SCHEMA_URL = "https://opencode.ai/tui.json"
const JSON_FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" }

export function updateOpenCodeConfigs(options: InstallOptions): ConfigEditResult[] {
  const configDir = resolveConfigDir(options.configDir)
  fs.mkdirSync(configDir, { recursive: true })

  return [
    updateConfigFile({
      kind: "opencode",
      file: path.join(configDir, "opencode.json"),
      schema: OPENCODE_SCHEMA_URL,
      spec: options.spec,
      action: options.action,
    }),
    updateConfigFile({
      kind: "tui",
      file: path.join(configDir, "tui.json"),
      schema: TUI_SCHEMA_URL,
      spec: options.spec,
      action: options.action,
    }),
  ]
}

export function defaultPluginSpec(): string {
  return PACKAGE_NAME
}

function updateConfigFile(params: {
  kind: ConfigEditResult["kind"]
  file: string
  schema: string
  spec: string
  action: InstallerAction
}): ConfigEditResult {
  const existed = fs.existsSync(params.file)
  const current = existed ? fs.readFileSync(params.file, "utf8") : undefined
  const next = current === undefined
    ? createConfig(params.schema, params.action === "init" ? params.spec : undefined)
    : updateExistingConfig(current, params.spec, params.action)
  const changed = next !== current
  if (changed) writeTextAtomic(params.file, next)

  return {
    kind: params.kind,
    path: params.file,
    existed,
    changed,
    message: buildMessage(params.action, params.kind, params.spec, changed),
  }
}

function updateExistingConfig(content: string, spec: string, action: InstallerAction): string {
  const root = parseConfigRoot(content)
  const config = getNodeValue(root) as Record<string, unknown>
  const plugins = Array.isArray(config.plugin) ? config.plugin : []

  if (action === "init") {
    if (plugins.some((plugin) => pluginMatches(plugin, spec))) return content
    const nextPlugins = [...plugins, spec]
    return applyConfigEdit(content, ["plugin"], nextPlugins)
  }

  const nextPlugins = plugins.filter((plugin) => !pluginMatches(plugin, spec))
  if (nextPlugins.length === plugins.length) return content
  if (nextPlugins.length === 0) return applyConfigEdit(content, ["plugin"], undefined)
  return applyConfigEdit(content, ["plugin"], nextPlugins)
}

function parseConfigRoot(content: string) {
  const errors: ParseError[] = []
  const root = parseTree(content, errors, { allowTrailingComma: true, disallowComments: false })
  if (!root || root.type !== "object") throw new Error("Config must contain a top-level JSON/JSONC object")
  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(`Config contains invalid JSONC near offset ${first.offset}: ${printParseErrorCode(first.error)}`)
  }
  return root
}

function applyConfigEdit(content: string, jsonPath: Array<string | number>, value: unknown): string {
  const edits = modify(content, jsonPath, value, { formattingOptions: JSON_FORMATTING })
  return applyEdits(content, edits)
}

function pluginMatches(plugin: unknown, spec: string): boolean {
  const value = Array.isArray(plugin) ? plugin[0] : plugin
  return typeof value === "string" && (value === spec || value === PACKAGE_NAME || value.endsWith(`/${PACKAGE_NAME}`))
}

function createConfig(schema: string, spec: string | undefined): string {
  const plugin = spec ? `,\n  "plugin": [\n    ${JSON.stringify(spec)}\n  ]` : ""
  return `{\n  "$schema": ${JSON.stringify(schema)}${plugin}\n}\n`
}

function writeTextAtomic(file: string, value: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, value, "utf8")
  fs.renameSync(tmp, file)
}

function resolveConfigDir(configDir: string | undefined): string {
  if (configDir) return expandHome(configDir)
  if (process.env.OPENCODE_CONFIG_DIR) return expandHome(process.env.OPENCODE_CONFIG_DIR)
  return getOpencodeRuntimeDirs().configDir
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

function buildMessage(action: InstallerAction, kind: string, spec: string, changed: boolean): string {
  if (action === "init") return changed ? `Added ${spec} to ${kind} config` : `${kind} config already includes ${spec}`
  return changed ? `Removed ${spec} from ${kind} config` : `${kind} config did not include ${spec}`
}
