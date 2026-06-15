import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

export type KeyRotatorConfig = {
  rotation: {
    enabled: boolean;
    dedupTtlMs: number;
    patterns: RegExp[];
  };
  storage: {
    maxBackups: number;
    lockTtlMs: number;
  };
  ui: {
    toastDurationMs: number;
  };
};

export const DEFAULT_ROTATION_PATTERNS = ["\\b429\\b", "rate\\s*limit", "quota", "resource exhausted", "usage limit", "insufficient quota"];

const DEFAULT_CONFIG: KeyRotatorConfig = {
  rotation: {
    enabled: true,
    dedupTtlMs: 5 * 60 * 1000,
    patterns: DEFAULT_ROTATION_PATTERNS.map((source) => new RegExp(source, "i")),
  },
  storage: {
    maxBackups: 10,
    lockTtlMs: 30_000,
  },
  ui: {
    toastDurationMs: 11_000,
  },
};

export type ConfigLoadOptions = {
  configDir?: string;
  configPath?: string;
};

export function loadConfig(options?: ConfigLoadOptions): KeyRotatorConfig {
  const configPath = resolveConfigPath(options);
  if (!configPath || !fs.existsSync(configPath)) {
    return cloneConfig(DEFAULT_CONFIG);
  }

  const raw = parseConfigFile(configPath);
  return mergeConfig(raw);
}

export function writeDefaultConfig(configDir: string): string {
  const configDirPath = path.join(configDir, "opencode-key-rotator");
  const configFile = path.join(configDirPath, "config.json");
  fs.mkdirSync(configDirPath, { recursive: true });

  const defaultConfig = {
    rotation: {
      enabled: DEFAULT_CONFIG.rotation.enabled,
      dedupTtlMs: DEFAULT_CONFIG.rotation.dedupTtlMs,
      patterns: DEFAULT_ROTATION_PATTERNS,
    },
    storage: {
      maxBackups: DEFAULT_CONFIG.storage.maxBackups,
      lockTtlMs: DEFAULT_CONFIG.storage.lockTtlMs,
    },
    ui: {
      toastDurationMs: DEFAULT_CONFIG.ui.toastDurationMs,
    },
  };

  fs.writeFileSync(configFile, `${JSON.stringify(defaultConfig, null, 2)}\n`, { mode: 0o600 });
  return configFile;
}

function resolveConfigPath(options?: ConfigLoadOptions): string | undefined {
  if (options?.configPath) return path.resolve(options.configPath);
  const configDir = options?.configDir ?? getOpencodeRuntimeDirs().configDir;
  return path.join(configDir, "opencode-key-rotator", "config.json");
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
  const storage = isJsonObject(raw.storage) ? raw.storage : {};
  const ui = isJsonObject(raw.ui) ? raw.ui : {};

  return {
    rotation: {
      enabled: typeof rotation.enabled === "boolean" ? rotation.enabled : DEFAULT_CONFIG.rotation.enabled,
      dedupTtlMs: positiveNumber(rotation.dedupTtlMs, DEFAULT_CONFIG.rotation.dedupTtlMs, "rotation.dedupTtlMs"),
      patterns: parsePatterns(rotation.patterns),
    },
    storage: {
      maxBackups: nonNegativeNumber(storage.maxBackups, DEFAULT_CONFIG.storage.maxBackups, "storage.maxBackups"),
      lockTtlMs: positiveNumber(storage.lockTtlMs, DEFAULT_CONFIG.storage.lockTtlMs, "storage.lockTtlMs"),
    },
    ui: {
      toastDurationMs: positiveNumber(ui.toastDurationMs, DEFAULT_CONFIG.ui.toastDurationMs, "ui.toastDurationMs"),
    },
  };
}

function parsePatterns(value: unknown): RegExp[] {
  if (value === undefined) return DEFAULT_CONFIG.rotation.patterns.map((pattern) => new RegExp(pattern.source, pattern.flags));
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

function positiveNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: KeyRotatorConfig): KeyRotatorConfig {
  return {
    rotation: {
      enabled: config.rotation.enabled,
      dedupTtlMs: config.rotation.dedupTtlMs,
      patterns: config.rotation.patterns.map((pattern) => new RegExp(pattern.source, pattern.flags)),
    },
    storage: { ...config.storage },
    ui: { ...config.ui },
  };
}
