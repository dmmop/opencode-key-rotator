export type OpencodeRuntimeDirs = {
    dataDir: string;
    configDir: string;
    cacheDir: string;
    stateDir: string;
};
export type OpencodeRuntimeDirCandidates = {
    dataDirs: string[];
    configDirs: string[];
    cacheDirs: string[];
    stateDirs: string[];
};
export type RuntimePathParams = {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
};
export type RuntimeDirCandidateParams = RuntimePathParams & {
    platform?: NodeJS.Platform;
    primary?: OpencodeRuntimeDirs;
};
/**
 * Resolve OpenCode runtime directories using XDG base directory conventions.
 *
 * Mirrors the logic used by OpenCode itself: each directory is the corresponding
 * XDG base directory suffixed with "opencode". Falls back to Linux-style dot
 * directories under the user's home directory when XDG variables are missing.
 */
export declare function getOpencodeRuntimeDirs(params?: RuntimePathParams): OpencodeRuntimeDirs;
/**
 * Generate prioritized candidate auth.json paths.
 *
 * OpenCode stores auth at `${Global.Path.data}/auth.json`. We generate
 * candidates based on OpenCode runtime dir semantics (xdg-basedir) plus
 * platform fallbacks for alternate/legacy installs.
 */
export declare function getAuthPaths(): string[];
/**
 * Generate prioritized candidate directories for OpenCode runtime paths.
 *
 * On Windows and macOS, legacy/alternate install locations are included so the
 * plugin can find auth.json even when the primary XDG resolution points
 * elsewhere.
 */
export declare function getOpencodeRuntimeDirCandidates(params?: RuntimeDirCandidateParams): OpencodeRuntimeDirCandidates;
