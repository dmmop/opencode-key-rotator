import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { KeyStoreError } from "./errors.js";
import { createKeyStore } from "./key-store.js";
import { sanitizeMessage, sanitizeRateLimitHeaders, writeRotationLog } from "./rotation-log.js";
const ROTATABLE_MESSAGE_PATTERNS = [
    /\b429\b/i,
    /rate\s*limit/i,
    /too many requests/i,
    /quota/i,
    /resource exhausted/i,
    /usage limit/i,
    /requests per minute/i,
    /tokens per minute/i,
    /insufficient quota/i,
];
export const server = async ({ client }) => {
    return {
        event: async ({ event }) => {
            if (event.type !== "session.error")
                return;
            const error = event.properties?.error;
            const info = normalizeError(error);
            const timestamp = new Date().toISOString();
            const dataDir = await resolveDataDir(client);
            if (!dataDir) {
                await showToast(client, "Key rotation skipped", "OpenCode data path is unavailable.", "warning");
                return;
            }
            const store = createKeyStore(dataDir);
            if (info.name === "MessageAbortedError") {
                writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "ignored", reason: "manual_abort" });
                return;
            }
            if (!isRotatableError(info)) {
                writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "not_rotatable", reason: "error_did_not_match_rotation_patterns" });
                return;
            }
            if (!info.providerID) {
                const inferred = await inferProvider(client, event.properties?.sessionID);
                if (inferred) {
                    info.providerID = inferred.providerID;
                    info.providerSource = inferred.source;
                }
            }
            if (!info.providerID) {
                writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "provider_unknown", reason: "rotatable_error_without_provider_id" });
                await showToast(client, "Key rotation skipped", "Provider could not be determined.", "warning");
                return;
            }
            if (!store.hasAlternativeKey(info.providerID)) {
                writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "no_alternative", reason: "provider_has_less_than_two_saved_keys" });
                await showToast(client, "Key rotation skipped", `${info.providerID} has no alternative key.`, "warning");
                return;
            }
            try {
                const result = store.rotateProviderKey(info.providerID);
                if (!result)
                    return;
                writeRotationLog(store, {
                    ...baseLogEntry(info, timestamp),
                    decision: "rotated",
                    reason: "matched_rotation_patterns",
                    activeAlias: result.previousAlias,
                    nextAlias: result.activeAlias,
                });
                await showToast(client, "Key rotated", `${info.providerID}: ${result.previousAlias ?? "unknown"} -> ${result.activeAlias}`, "success");
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const activeAlias = readActiveAliasSafely(store, info.providerID);
                const fingerprintMismatch = message.includes("no longer match alias");
                writeRotationLog(store, {
                    ...baseLogEntry(info, timestamp),
                    message: `${info.message ?? ""}\nrotation_error=${message}`,
                    decision: fingerprintMismatch ? "fingerprint_mismatch" : "error",
                    reason: fingerprintMismatch ? "active_credentials_changed_outside_plugin" : error instanceof KeyStoreError ? "key_store_error" : "unexpected_rotation_error",
                    activeAlias,
                });
                await showToast(client, "Key rotation failed", sanitizeMessage(message) ?? "Unknown error", "error");
            }
        },
    };
};
function baseLogEntry(info, timestamp) {
    return {
        timestamp,
        providerID: info.providerID,
        providerSource: info.providerSource,
        errorName: info.name,
        statusCode: info.statusCode,
        message: info.message,
        rateLimitHeaders: sanitizeRateLimitHeaders(info.headers),
    };
}
function normalizeError(error) {
    if (!error || typeof error !== "object")
        return { message: String(error) };
    const record = error;
    const name = typeof record.name === "string" ? record.name : undefined;
    const data = record.data && typeof record.data === "object" ? record.data : undefined;
    return {
        name,
        providerID: typeof data?.providerID === "string" ? data.providerID : undefined,
        providerSource: typeof data?.providerID === "string" ? "error" : undefined,
        statusCode: typeof data?.statusCode === "number" ? data.statusCode : undefined,
        message: typeof data?.message === "string" ? data.message : errorToMessage(error),
        headers: data?.responseHeaders && typeof data.responseHeaders === "object" ? data.responseHeaders : undefined,
    };
}
async function inferProvider(client, sessionID) {
    const fromSession = sessionID ? await inferProviderFromMessages(client, sessionID) : undefined;
    if (fromSession)
        return fromSession;
    return inferProviderFromConfig(client);
}
async function inferProviderFromMessages(client, sessionID) {
    try {
        const response = await client.session.messages({
            path: { id: sessionID },
            query: { limit: 10 },
        });
        const messages = extractData(response);
        if (!Array.isArray(messages))
            return undefined;
        for (const entry of [...messages].reverse()) {
            const message = isRecord(entry) && isRecord(entry.info) ? entry.info : entry;
            if (!isRecord(message))
                continue;
            if (message.role === "assistant" && typeof message.providerID === "string") {
                return { providerID: message.providerID, source: "session_message_assistant" };
            }
            if (message.role === "user" && isRecord(message.model) && typeof message.model.providerID === "string") {
                return { providerID: message.model.providerID, source: "session_message_user" };
            }
        }
    }
    catch {
        // Fall back to config model below.
    }
    return undefined;
}
async function inferProviderFromConfig(client) {
    try {
        const config = extractData(await client.config.get());
        if (!isRecord(config) || typeof config.model !== "string")
            return undefined;
        const providerID = config.model.split("/")[0];
        return providerID ? { providerID, source: "config_model" } : undefined;
    }
    catch {
        return undefined;
    }
}
async function resolveDataDir(client) {
    try {
        const pathResponse = extractData(await client.path.get());
        if (!isRecord(pathResponse) || typeof pathResponse.state !== "string")
            return undefined;
        // Validate that OpenCode runtime paths are available, then derive the data
        // directory using the same XDG logic OpenCode uses.
        return getOpencodeRuntimeDirs().dataDir;
    }
    catch {
        return undefined;
    }
}
function readActiveAliasSafely(store, providerID) {
    if (!providerID)
        return undefined;
    try {
        return store.readActiveAliases()[providerID];
    }
    catch {
        return undefined;
    }
}
function extractData(value) {
    if (isRecord(value) && "data" in value)
        return value.data;
    return value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isRotatableError(info) {
    if (info.name === "MessageOutputLengthError")
        return false;
    if (info.statusCode === 429)
        return true;
    const message = info.message ?? "";
    return ROTATABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}
function errorToMessage(error) {
    if (error instanceof Error)
        return error.message;
    try {
        return JSON.stringify(error);
    }
    catch {
        return undefined;
    }
}
async function showToast(client, title, message, variant) {
    try {
        await client.tui.showToast({
            body: { title, message, variant, duration: 8_000 },
        });
    }
    catch {
        console.warn(`[opencode-key-rotator] ${title}: ${message}`);
    }
}
//# sourceMappingURL=server.js.map