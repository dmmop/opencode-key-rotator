import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { KeyStoreError } from "./errors.js";
const MAX_AUTH_BACKUPS = 10;
const LOCK_TTL_MS = 30_000;
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
const RESERVED_SEGMENTS = new Set(["backups", ".lock"]);
export function createKeyStore(dataDir) {
    const paths = createKeyStorePaths(dataDir);
    function ensureKeysDir() {
        fs.mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 });
        chmodIfExists(paths.keysDir, 0o700);
    }
    function readAuth() {
        return readAuthOptional();
    }
    function readAuthOptional() {
        if (!fs.existsSync(paths.authFile))
            return {};
        return readJsonObject(paths.authFile, "OpenCode auth file");
    }
    function readAuthRequired() {
        if (!fs.existsSync(paths.authFile))
            throw new KeyStoreError("AUTH_MISSING", `OpenCode auth file was not found at ${paths.authFile}`);
        return readJsonObject(paths.authFile, "OpenCode auth file");
    }
    function readActiveState() {
        if (!fs.existsSync(paths.activeFile))
            return { providers: {} };
        const active = readJsonObject(paths.activeFile, "active key file");
        if (!isJsonObject(active.providers))
            throw new KeyStoreError("AUTH_INVALID", "active key file must contain a providers object");
        const providers = {};
        for (const [providerID, value] of Object.entries(active.providers)) {
            validateProviderID(providerID);
            if (!isJsonObject(value) || typeof value.alias !== "string" || typeof value.updatedAt !== "string") {
                throw new KeyStoreError("AUTH_INVALID", `Invalid active metadata for provider '${providerID}'`);
            }
            validateAlias(value.alias);
            if (!isFingerprint(value.fingerprint)) {
                throw new KeyStoreError("AUTH_INVALID", `Invalid fingerprint metadata for provider '${providerID}'`);
            }
            providers[providerID] = {
                alias: value.alias,
                fingerprint: value.fingerprint,
                updatedAt: value.updatedAt,
            };
        }
        return { providers };
    }
    function readActiveAliases() {
        const active = readActiveState();
        return Object.fromEntries(Object.entries(active.providers).map(([providerID, provider]) => [providerID, provider.alias]));
    }
    function listKeys(providerID) {
        ensureKeysDir();
        const providerIDs = fs.readdirSync(paths.keysDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== "backups")
            .map((entry) => entry.name)
            .filter((entry) => providerID === undefined || entry === providerID);
        return providerIDs.flatMap((currentProviderID) => listProviderKeys(currentProviderID))
            .sort((left, right) => `${left.providerID}/${left.alias}`.localeCompare(`${right.providerID}/${right.alias}`));
    }
    function listProviderIDs() {
        const auth = readAuthRequired();
        const active = readActiveState();
        const fromKeys = listKeys().map((entry) => entry.providerID);
        return [...new Set([...Object.keys(auth), ...Object.keys(active.providers), ...fromKeys])].sort();
    }
    function getStatuses() {
        const active = readActiveState();
        const keys = listKeys();
        const aliasesByProvider = new Map();
        for (const key of keys) {
            const aliases = aliasesByProvider.get(key.providerID) ?? [];
            aliases.push(key.alias);
            aliasesByProvider.set(key.providerID, aliases);
        }
        let auth = {};
        let authWarning;
        try {
            auth = readAuth();
        }
        catch (error) {
            authWarning = error instanceof Error ? error.message : String(error);
        }
        const providers = new Set([...Object.keys(active.providers), ...aliasesByProvider.keys(), ...Object.keys(auth)]);
        return [...providers].sort().map((providerID) => {
            const activeProvider = active.providers[providerID];
            const currentCredential = auth[providerID];
            const synced = activeProvider && isJsonObject(currentCredential)
                ? sameFingerprint(calculateFingerprint(currentCredential), activeProvider.fingerprint)
                : undefined;
            return {
                providerID,
                activeAlias: activeProvider?.alias,
                aliases: aliasesByProvider.get(providerID) ?? [],
                authWarning,
                synced,
            };
        });
    }
    function saveCurrentProviderKey(providerID, alias, markActive) {
        validateProviderID(providerID);
        validateAlias(alias);
        const auth = readAuth();
        const credential = auth[providerID];
        if (!isJsonObject(credential)) {
            throw new KeyStoreError("AUTH_MISSING", `Provider '${providerID}' was not found in auth.json`);
        }
        return withLock(() => {
            const file = keyFilePath(providerID, alias);
            const currentFingerprint = calculateFingerprint(credential);
            const previous = fs.existsSync(file) ? readJsonObject(file, `key '${providerID}/${alias}'`) : undefined;
            const previousFingerprint = previous ? calculateFingerprint(previous) : undefined;
            ensureProviderDir(providerID);
            writeJsonAtomic(file, credential);
            if (markActive) {
                const active = readActiveState();
                active.providers[providerID] = activeProvider(alias, currentFingerprint);
                writeJsonAtomic(paths.activeFile, active);
            }
            return {
                providerID,
                alias,
                file,
                fingerprint: currentFingerprint,
                replaced: previous !== undefined,
                fingerprintChanged: previousFingerprint !== undefined && !sameFingerprint(previousFingerprint, currentFingerprint),
            };
        });
    }
    function previewCurrentProviderKey(providerID, alias) {
        validateProviderID(providerID);
        validateAlias(alias);
        const auth = readAuthRequired();
        const credential = auth[providerID];
        if (!isJsonObject(credential)) {
            throw new KeyStoreError("AUTH_MISSING", `Provider '${providerID}' was not found in auth.json`);
        }
        const fingerprint = calculateFingerprint(credential);
        const file = keyFilePath(providerID, alias);
        if (!fs.existsSync(file))
            return { exists: false, fingerprintChanged: false, fingerprint };
        const existingFingerprint = calculateFingerprint(readJsonObject(file, `key '${providerID}/${alias}'`));
        return { exists: true, fingerprintChanged: !sameFingerprint(fingerprint, existingFingerprint), fingerprint, existingFingerprint };
    }
    function switchProviderKey(providerID, alias, reason = "key-switch") {
        validateProviderID(providerID);
        validateAlias(alias);
        return withLock(() => switchProviderKeyUnlocked(providerID, alias, reason, true));
    }
    function rotateProviderKey(providerID) {
        validateProviderID(providerID);
        return withLock(() => {
            const keys = listKeys(providerID);
            if (keys.length < 2)
                return undefined;
            const active = readActiveState();
            const currentAlias = active.providers[providerID]?.alias;
            const currentIndex = currentAlias ? keys.findIndex((entry) => entry.alias === currentAlias) : -1;
            const next = keys[(currentIndex + 1 + keys.length) % keys.length];
            return switchProviderKeyUnlocked(providerID, next.alias, "auto-rotate", true);
        });
    }
    function hasAlternativeKey(providerID) {
        return listKeys(providerID).length >= 2;
    }
    function keyExists(providerID, alias) {
        validateProviderID(providerID);
        validateAlias(alias);
        return fs.existsSync(keyFilePath(providerID, alias));
    }
    function backupAuth(reason) {
        ensureKeysDir();
        fs.mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
        chmodIfExists(paths.backupsDir, 0o700);
        if (!fs.existsSync(paths.authFile)) {
            throw new KeyStoreError("AUTH_MISSING", "Cannot back up auth.json because it does not exist");
        }
        const safeReason = reason.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "auth-write";
        const backupFile = path.join(paths.backupsDir, `auth-${timestampForFile()}-${process.pid}-${safeReason}.json`);
        try {
            fs.copyFileSync(paths.authFile, backupFile, fs.constants.COPYFILE_EXCL);
            chmodIfExists(backupFile, 0o600);
            return backupFile;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new KeyStoreError("BACKUP_FAILED", `Failed to back up auth.json: ${message}`);
        }
    }
    function pruneAuthBackups(maxBackups = MAX_AUTH_BACKUPS) {
        if (!fs.existsSync(paths.backupsDir))
            return;
        const backups = fs.readdirSync(paths.backupsDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /^auth-.*\.json$/.test(entry.name))
            .map((entry) => {
            const file = path.join(paths.backupsDir, entry.name);
            return { file, mtimeMs: fs.statSync(file).mtimeMs };
        })
            .sort((left, right) => right.mtimeMs - left.mtimeMs);
        for (const backup of backups.slice(maxBackups)) {
            fs.rmSync(backup.file, { force: true });
        }
    }
    function switchProviderKeyUnlocked(providerID, alias, reason, persistCurrent) {
        const active = readActiveState();
        const previous = active.providers[providerID];
        const previousAlias = previous?.alias;
        if (previous) {
            const auth = readAuthRequired();
            const currentCredential = auth[providerID];
            if (currentCredential === undefined)
                throw new KeyStoreError("AUTH_MISSING", `Provider '${providerID}' was not found in auth.json`);
            if (!isJsonObject(currentCredential))
                throw new KeyStoreError("AUTH_INVALID", `Provider '${providerID}' in auth.json must contain a JSON object`);
            const currentFingerprint = calculateFingerprint(currentCredential);
            if (!sameFingerprint(currentFingerprint, previous.fingerprint)) {
                throw new KeyStoreError("FINGERPRINT_MISMATCH", `Active ${providerID} credentials no longer match alias '${previous.alias}'. Run /key-save before switching.`);
            }
            if (persistCurrent) {
                writeJsonAtomic(keyFilePath(providerID, previous.alias), currentCredential);
            }
        }
        const next = readJsonObject(keyFilePath(providerID, alias), `key '${providerID}/${alias}'`);
        const nextFingerprint = calculateFingerprint(next);
        const auth = readAuthRequired();
        backupAuth(reason);
        auth[providerID] = next;
        writeJsonAtomic(paths.authFile, auth);
        active.providers[providerID] = activeProvider(alias, nextFingerprint);
        writeJsonAtomic(paths.activeFile, active);
        pruneAuthBackups();
        return { providerID, previousAlias, activeAlias: alias };
    }
    function listProviderKeys(providerID) {
        validateProviderID(providerID);
        const providerDir = path.join(paths.keysDir, providerID);
        if (!fs.existsSync(providerDir))
            return [];
        return fs.readdirSync(providerDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => {
            const alias = entry.name.slice(0, -".json".length);
            if (!SAFE_SEGMENT.test(alias))
                return undefined;
            const file = path.join(providerDir, entry.name);
            return { providerID, alias, file, fingerprint: calculateFingerprint(readJsonObject(file, `key '${providerID}/${alias}'`)) };
        })
            .filter((entry) => entry !== undefined);
    }
    function keyFilePath(providerID, alias) {
        validateProviderID(providerID);
        validateAlias(alias);
        return path.join(paths.keysDir, providerID, `${alias}.json`);
    }
    function ensureProviderDir(providerID) {
        validateProviderID(providerID);
        ensureKeysDir();
        const providerDir = path.join(paths.keysDir, providerID);
        fs.mkdirSync(providerDir, { recursive: true, mode: 0o700 });
        chmodIfExists(providerDir, 0o700);
    }
    function withLock(operation) {
        ensureKeysDir();
        const lockFile = paths.lockFile;
        const now = Date.now();
        try {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() }), { flag: "wx", mode: 0o600 });
        }
        catch (error) {
            if (!isStaleLock(lockFile, now))
                throw new KeyStoreError("BUSY", "Key store is busy. Try again in a moment.");
            fs.rmSync(lockFile, { force: true });
            try {
                fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString() }), { flag: "wx", mode: 0o600 });
            }
            catch {
                throw new KeyStoreError("LOCK_RACE", "Key store is busy. Try again in a moment.");
            }
        }
        try {
            return operation();
        }
        finally {
            fs.rmSync(lockFile, { force: true });
        }
    }
    function writeJsonAtomic(file, value) {
        const directory = path.dirname(file);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, file);
        chmodIfExists(file, 0o600);
    }
    return {
        paths,
        ensureKeysDir,
        readAuth,
        readActiveState,
        readActiveAliases,
        listKeys,
        listProviderIDs,
        getStatuses,
        saveCurrentProviderKey,
        previewCurrentProviderKey,
        switchProviderKey,
        rotateProviderKey,
        hasAlternativeKey,
        keyExists,
        backupAuth,
        pruneAuthBackups,
        calculateFingerprint,
    };
}
function createKeyStorePaths(dataDir) {
    const resolvedDataDir = path.resolve(dataDir);
    const keysDir = path.join(resolvedDataDir, "keys");
    return {
        dataDir: resolvedDataDir,
        authFile: path.join(resolvedDataDir, "auth.json"),
        keysDir,
        activeFile: path.join(keysDir, "active.json"),
        backupsDir: path.join(keysDir, "backups"),
        lockFile: path.join(keysDir, ".lock"),
        rotationLogFile: path.join(keysDir, "rotation.log.jsonl"),
    };
}
function calculateFingerprint(credential) {
    const type = typeof credential.type === "string" ? credential.type : "unknown";
    if (type === "oauth") {
        const accountId = stringValue(credential.accountId);
        const enterpriseUrl = stringValue(credential.enterpriseUrl);
        if (accountId)
            return fingerprint("oauth", "stable", [type, accountId, enterpriseUrl]);
        if (enterpriseUrl)
            return fingerprint("oauth", "stable", [type, enterpriseUrl]);
        return fingerprint("oauth", "unstable", [type, stringValue(credential.refresh), stringValue(credential.access)]);
    }
    if (type === "api")
        return fingerprint("api", "stable", [type, stringValue(credential.key)]);
    if (type === "wellknown")
        return fingerprint("wellknown", "unstable", [type, stringValue(credential.key), stringValue(credential.token)]);
    return fingerprint("unknown", "unstable", [JSON.stringify(redactCredentialShape(credential))]);
}
function activeProvider(alias, fingerprintValue) {
    return {
        alias,
        fingerprint: fingerprintValue,
        updatedAt: new Date().toISOString(),
    };
}
function fingerprint(type, stability, parts) {
    const material = parts.map((part) => part ?? "").join("\0");
    return { hash: `sha256:${crypto.createHash("sha256").update(material).digest("hex")}`, type, stability };
}
function sameFingerprint(left, right) {
    return left.hash === right.hash && left.type === right.type && left.stability === right.stability;
}
function validateProviderID(providerID) {
    if (!isSafeSegment(providerID))
        throw new KeyStoreError("INVALID_INPUT", "Invalid provider ID");
}
function validateAlias(alias) {
    if (!isSafeSegment(alias)) {
        throw new KeyStoreError("INVALID_INPUT", "Alias must contain only letters, numbers, dots, underscores, or dashes, and cannot use reserved names");
    }
}
function isSafeSegment(segment) {
    return SAFE_SEGMENT.test(segment) && !segment.includes("..") && !RESERVED_SEGMENTS.has(segment);
}
function readJsonObject(file, label) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new KeyStoreError("AUTH_INVALID", `Failed to read ${label}: ${message}`);
    }
    if (!isJsonObject(parsed))
        throw new KeyStoreError("AUTH_INVALID", `${label} must contain a JSON object`);
    return parsed;
}
function isStaleLock(lockFile, now) {
    try {
        return now - fs.statSync(lockFile).mtimeMs > LOCK_TTL_MS;
    }
    catch {
        return true;
    }
}
function timestampForFile() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\./g, "");
}
function chmodIfExists(file, mode) {
    try {
        fs.chmodSync(file, mode);
    }
    catch {
        // Non-fatal on filesystems that do not support chmod.
    }
}
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFingerprint(value) {
    return isJsonObject(value)
        && typeof value.hash === "string"
        && (value.type === "oauth" || value.type === "api" || value.type === "wellknown" || value.type === "unknown")
        && (value.stability === "stable" || value.stability === "unstable");
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
function redactCredentialShape(credential) {
    return Object.fromEntries(Object.keys(credential).sort().map((key) => [key, typeof credential[key]]));
}
//# sourceMappingURL=key-store.js.map