import * as fs from "node:fs";
const MAX_MESSAGE_LENGTH = 500;
export function writeRotationLog(store, entry) {
    try {
        store.ensureKeysDir();
        const line = JSON.stringify({ ...entry, message: sanitizeMessage(entry.message) });
        fs.appendFileSync(store.paths.rotationLogFile, `${line}\n`, { mode: 0o600 });
        fs.chmodSync(store.paths.rotationLogFile, 0o600);
    }
    catch {
        // Diagnostics must never break OpenCode usage.
    }
}
export function readLastRotationDecision(store) {
    try {
        if (!fs.existsSync(store.paths.rotationLogFile))
            return undefined;
        const lines = fs.readFileSync(store.paths.rotationLogFile, "utf8").trim().split("\n").filter(Boolean);
        const last = lines.at(-1);
        if (!last)
            return undefined;
        return JSON.parse(last);
    }
    catch {
        return undefined;
    }
}
export function sanitizeMessage(message) {
    if (!message)
        return undefined;
    return message
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
        .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|secret)[=:]\s*[A-Za-z0-9._~+/=-]+/gi, "$1=[redacted]")
        .slice(0, MAX_MESSAGE_LENGTH);
}
export function sanitizeRateLimitHeaders(headers) {
    if (!headers || typeof headers !== "object")
        return undefined;
    const result = {};
    for (const [key, value] of Object.entries(headers)) {
        const normalized = key.toLowerCase();
        if ((normalized === "retry-after" || normalized.startsWith("x-ratelimit-")) && typeof value === "string") {
            result[normalized] = value.slice(0, 120);
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
//# sourceMappingURL=rotation-log.js.map