import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export type KeyRotatorConfig = {
  rotation: {
    enabled: boolean;
    patterns: RegExp[];
  };
};

export const DEFAULT_ROTATION_PATTERNS = ["\\b429\\b", "rate\\s*limit", "quota", "resource exhausted", "usage limit", "insufficient quota"];

export type ConfigLoadOptions = { configDir?: string };

export function loadConfig(options?: ConfigLoadOptions): KeyRotatorConfig {
  const file = path.join(options?.configDir ?? getOpencodeRuntimeDirs().configDir, "opencode-key-rotator", "config.json");
  return fs.existsSync(file) ? mergeConfig(parseConfigFile(file)) : defaultConfig();
}

export function writeDefaultConfig(configDir: string): string {
  const configDirPath = path.join(configDir, "opencode-key-rotator");
  const configFile = path.join(configDirPath, "config.json");
  fs.mkdirSync(configDirPath, { recursive: true });
  if (fs.existsSync(configFile)) return configFile;

  const defaultConfig = {
    rotation: {
      enabled: true,
      patterns: DEFAULT_ROTATION_PATTERNS,
    },
  };

  const tmp = path.join(configDirPath, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(defaultConfig, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configFile);
  return configFile;
}

function parseConfigFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = parseJsonc(content);
  if (parsed === undefined) throw new Error(`Config file at ${filePath} contains invalid JSON/JSONC`);
  return parsed;
}

function mergeConfig(raw: unknown): KeyRotatorConfig {
  if (!isJsonObject(raw)) throw new Error("Config must be a JSON object");

  const rotation = isJsonObject(raw.rotation) ? raw.rotation : {};
  return {
    rotation: {
      enabled: typeof rotation.enabled === "boolean" ? rotation.enabled : true,
      patterns: parsePatterns(rotation.patterns),
    },
  };
}

function parsePatterns(value: unknown): RegExp[] {
  if (value === undefined) return defaultPatterns();
  if (!Array.isArray(value)) throw new Error("rotation.patterns must be an array of regex strings");
  return value.map((entry, index) => parsePattern(entry, index));
}

function parsePattern(value: unknown, index: number): RegExp {
  if (typeof value !== "string") throw new Error(`rotation.patterns[${index}] must be a regex string`);
  try {
    return new RegExp(value, "i");
  } catch {
    throw new Error(`rotation.patterns[${index}] is not a valid regex: ${value}`);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultConfig(): KeyRotatorConfig {
  return {
    rotation: {
      enabled: true,
      patterns: defaultPatterns(),
    },
  };
}

function defaultPatterns(): RegExp[] {
  return DEFAULT_ROTATION_PATTERNS.map((source) => new RegExp(source, "i"));
}
