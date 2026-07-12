import { homedir } from "node:os";
import { join } from "node:path";

export type OpencodeRuntimeDirs = {
  dataDir: string;
  configDir: string;
};

export type RuntimePathParams = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

function getEnvOrFallback(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  if (value) return value;
  return fallback;
}

/**
 * Resolve OpenCode runtime directories using XDG base directory conventions.
 *
 * Each directory is its XDG base directory suffixed with "opencode".
 */
export function getOpencodeRuntimeDirs(params?: RuntimePathParams): OpencodeRuntimeDirs {
  const env = params?.env ?? process.env;
  const home = params?.homeDir ?? homedir();
  const platform = params?.platform ?? process.platform;

  const dataFallback =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
        : join(home, ".local", "share");
  const configFallback =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
        : join(home, ".config");

  const dataBase = getEnvOrFallback(env, "XDG_DATA_HOME", dataFallback);
  const configBase = getEnvOrFallback(env, "XDG_CONFIG_HOME", configFallback);

  return {
    dataDir: join(dataBase, "opencode"),
    configDir: join(configBase, "opencode"),
  };
}

export function resolveOpencodeDataDir(pathInfo?: unknown): string {
  if (isRecord(pathInfo) && typeof pathInfo.data === "string" && pathInfo.data.trim()) {
    return pathInfo.data;
  }
  return getOpencodeRuntimeDirs().dataDir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
