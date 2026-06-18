import * as fs from "node:fs";
import type { KeyStore } from "./key-store.js";

export type RotationDecision =
  | "rotated"
  | "rotated_on_retry"
  | "not_rotatable"
  | "no_alternative"
  | "provider_unknown"
  | "ignored"
  | "error"
  | "fingerprint_mismatch"
  | "all_keys_cooling_down";

export type RotationLogEntry = {
  timestamp: string;
  sessionID?: string;
  attempt?: number;
  isRetryable?: boolean;
  providerID?: string;
  providerSource?: string;
  errorName?: string;
  statusCode?: number;
  message?: string;
  rateLimitHeaders?: Record<string, string>;
  decision: RotationDecision;
  reason: string;
  activeAlias?: string;
  nextAlias?: string;
};

const MAX_MESSAGE_LENGTH = 500;

export function writeRotationLog(store: KeyStore, entry: RotationLogEntry): void {
  try {
    store.ensureKeysDir();
    const line = JSON.stringify({ ...entry, message: sanitizeMessage(entry.message) });
    fs.appendFileSync(store.paths.rotationLogFile, `${line}\n`, { mode: 0o600 });
    fs.chmodSync(store.paths.rotationLogFile, 0o600);
  } catch {
    // Diagnostics must never break OpenCode usage.
  }
}

export function readLastRotationDecision(store: KeyStore): RotationLogEntry | undefined {
  try {
    if (!fs.existsSync(store.paths.rotationLogFile)) return undefined;
    const lines = fs.readFileSync(store.paths.rotationLogFile, "utf8").trim().split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = JSON.parse(lines[index]) as RotationLogEntry;
      if (entry.reason !== "manual_abort") return entry;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|secret)[=:]\s*[A-Za-z0-9._~+/=-]+/gi, "$1=[redacted]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

export function sanitizeRateLimitHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if ((normalized === "retry-after" || normalized.startsWith("x-ratelimit-")) && typeof value === "string") {
      result[normalized] = value.slice(0, 120);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
