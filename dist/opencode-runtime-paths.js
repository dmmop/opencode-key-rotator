import { homedir } from "node:os";
import { join } from "node:path";
import { xdgCache, xdgConfig, xdgData, xdgState } from "xdg-basedir";
function dedupe(list) {
    const out = [];
    const seen = new Set();
    for (const item of list) {
        if (!item || seen.has(item))
            continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}
function getEnvOrFallback(env, key, fallback) {
    const value = env[key]?.trim();
    if (value)
        return value;
    return fallback;
}
/**
 * Resolve OpenCode runtime directories using XDG base directory conventions.
 *
 * Mirrors the logic used by OpenCode itself: each directory is the corresponding
 * XDG base directory suffixed with "opencode". Falls back to Linux-style dot
 * directories under the user's home directory when XDG variables are missing.
 */
export function getOpencodeRuntimeDirs(params) {
    const env = params?.env ?? process.env;
    const home = params?.homeDir ?? homedir();
    const platform = params?.platform ?? process.platform;
    const dataFallback = platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".local", "share");
    const configFallback = platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
    const cacheFallback = platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache");
    const dataBase = getEnvOrFallback(env, "XDG_DATA_HOME", platform === "darwin" ? dataFallback : xdgData ?? dataFallback);
    const configBase = getEnvOrFallback(env, "XDG_CONFIG_HOME", platform === "darwin" ? configFallback : xdgConfig ?? configFallback);
    const cacheBase = getEnvOrFallback(env, "XDG_CACHE_HOME", platform === "darwin" ? cacheFallback : xdgCache ?? cacheFallback);
    const stateBase = getEnvOrFallback(env, "XDG_STATE_HOME", xdgState ?? join(home, ".local", "state"));
    return {
        dataDir: join(dataBase, "opencode"),
        configDir: join(configBase, "opencode"),
        cacheDir: join(cacheBase, "opencode"),
        stateDir: join(stateBase, "opencode"),
    };
}
/**
 * Generate prioritized candidate auth.json paths.
 *
 * OpenCode stores auth at `${Global.Path.data}/auth.json`. We generate
 * candidates based on OpenCode runtime dir semantics (xdg-basedir) plus
 * platform fallbacks for alternate/legacy installs.
 */
export function getAuthPaths() {
    const { dataDirs } = getOpencodeRuntimeDirCandidates();
    return dataDirs.map((directory) => join(directory, "auth.json"));
}
export function resolveOpencodeDataDir(pathInfo) {
    if (isRecord(pathInfo) && typeof pathInfo.data === "string" && pathInfo.data.trim()) {
        return pathInfo.data;
    }
    return getOpencodeRuntimeDirs().dataDir;
}
/**
 * Generate prioritized candidate directories for OpenCode runtime paths.
 *
 * On Windows and macOS, legacy/alternate install locations are included so the
 * plugin can find auth.json even when the primary XDG resolution points
 * elsewhere.
 */
export function getOpencodeRuntimeDirCandidates(params) {
    const platform = params?.platform ?? process.platform;
    const env = params?.env ?? process.env;
    const home = params?.homeDir ?? homedir();
    const primary = params?.primary ?? getOpencodeRuntimeDirs({ env, homeDir: home, platform });
    const winAppData = env.APPDATA?.trim();
    const winLocalAppData = env.LOCALAPPDATA?.trim();
    const windowsRoamingFallback = join(home, "AppData", "Roaming");
    const windowsLocalFallback = join(home, "AppData", "Local");
    const dataDirs = [primary.dataDir];
    const configDirs = [primary.configDir];
    const cacheDirs = [primary.cacheDir];
    const stateDirs = [primary.stateDir];
    if (platform === "win32") {
        const appDataBase = winAppData || windowsRoamingFallback;
        const localAppDataBase = winLocalAppData || windowsLocalFallback;
        dataDirs.push(join(appDataBase, "opencode"), join(localAppDataBase, "opencode"));
        configDirs.push(join(appDataBase, "opencode"), join(localAppDataBase, "opencode"));
        cacheDirs.push(join(localAppDataBase, "opencode"));
        stateDirs.push(join(localAppDataBase, "opencode"));
    }
    else if (platform === "darwin") {
        dataDirs.push(join(home, ".local", "share", "opencode"));
        configDirs.push(join(home, ".config", "opencode"));
        cacheDirs.push(join(home, ".cache", "opencode"));
        stateDirs.push(join(home, ".local", "state", "opencode"));
        dataDirs.push(join(home, "Library", "Application Support", "opencode"));
        configDirs.push(join(home, "Library", "Application Support", "opencode"));
        cacheDirs.push(join(home, "Library", "Caches", "opencode"));
    }
    else {
        dataDirs.push(join(home, ".local", "share", "opencode"));
        configDirs.push(join(home, ".config", "opencode"));
        cacheDirs.push(join(home, ".cache", "opencode"));
        stateDirs.push(join(home, ".local", "state", "opencode"));
    }
    return {
        dataDirs: dedupe(dataDirs),
        configDirs: dedupe(configDirs),
        cacheDirs: dedupe(cacheDirs),
        stateDirs: dedupe(stateDirs),
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=opencode-runtime-paths.js.map