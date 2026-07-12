import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";
import { writeDefaultConfig } from "./config.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export type InstallerAction = "init" | "uninstall";
export type ConfigEditResult = {
  kind: "opencode" | "key-rotator";
  path: string;
  changed: boolean;
  message: string;
};
export type InstallOptions = { action: InstallerAction; configDir?: string };

const PACKAGE_NAME = "opencode-key-rotator";
const JSON_FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" };

export function updateOpenCodeConfigs(options: InstallOptions): ConfigEditResult[] {
  const configDir = resolveConfigDir(options.configDir);
  if (options.action === "init") fs.mkdirSync(configDir, { recursive: true });
  const result = updateOpenCodeConfig(path.join(configDir, "opencode.json"), options.action);
  if (options.action === "uninstall") return [result];

  const sidecar = path.join(configDir, PACKAGE_NAME, "config.json");
  const existed = fs.existsSync(sidecar);
  writeDefaultConfig(configDir);
  return [
    result,
    {
      kind: "key-rotator",
      path: sidecar,
      changed: !existed,
      message: existed ? "Preserved existing key-rotator config" : "Created default key-rotator config",
    },
  ];
}

function updateOpenCodeConfig(file: string, action: InstallerAction): ConfigEditResult {
  const existed = fs.existsSync(file);
  if (!existed && action === "uninstall") return { kind: "opencode", path: file, changed: false, message: "Plugin was not installed" };

  const current = existed ? fs.readFileSync(file, "utf8") : undefined;
  const next = current === undefined ? createConfig() : editConfig(current, action);
  const changed = next !== current;
  if (changed) writeTextAtomic(file, next);
  const message =
    action === "init"
      ? changed
        ? `Added ${PACKAGE_NAME} to opencode config`
        : `${PACKAGE_NAME} is already installed`
      : changed
        ? `Uninstalled ${PACKAGE_NAME} from opencode config`
        : `${PACKAGE_NAME} was not installed`;
  return { kind: "opencode", path: file, changed, message };
}

function editConfig(content: string, action: InstallerAction): string {
  const root = parseConfigRoot(content);
  const config = getNodeValue(root) as Record<string, unknown>;
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  if (action === "init") {
    if (plugins.some(isKeyRotator)) return content;
    return applyConfigEdit(content, ["plugins"], [...plugins, PACKAGE_NAME]);
  }
  const filtered = plugins.filter((plugin) => !isKeyRotator(plugin));
  if (filtered.length === plugins.length) return content;
  return applyConfigEdit(content, ["plugins"], filtered.length > 0 ? filtered : undefined);
}

function isKeyRotator(plugin: unknown): boolean {
  const value = typeof plugin === "object" && plugin !== null && "package" in plugin ? plugin.package : plugin;
  return typeof value === "string" && (value === PACKAGE_NAME || value.endsWith(`/${PACKAGE_NAME}`));
}

function parseConfigRoot(content: string) {
  const errors: ParseError[] = [];
  const root = parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (!root || root.type !== "object") throw new Error("Config must contain a top-level JSON/JSONC object");
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`Config contains invalid JSONC near offset ${first.offset}: ${printParseErrorCode(first.error)}`);
  }
  return root;
}

function applyConfigEdit(content: string, jsonPath: Array<string | number>, value: unknown): string {
  return applyEdits(content, modify(content, jsonPath, value, { formattingOptions: JSON_FORMATTING }));
}

function createConfig(): string {
  return `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": [\n    "${PACKAGE_NAME}"\n  ]\n}\n`;
}

function writeTextAtomic(file: string, value: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, file);
}

function resolveConfigDir(configDir: string | undefined): string {
  const value = configDir ?? process.env.OPENCODE_CONFIG_DIR;
  if (!value) return getOpencodeRuntimeDirs().configDir;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
