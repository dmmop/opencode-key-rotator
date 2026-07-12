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
  | "all_keys_cooling_down"
  | "diagnostic";

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
  eventType?: string;
  decision: RotationDecision;
  reason: string;
  activeAlias?: string;
  nextAlias?: string;
  coolingDownAlias?: string;
  cooldownEnteredAt?: string;
  cooldownExpiresAt?: string;
  cooldownMs?: number;
  cooldownState?: string;
};

const MAX_MESSAGE_LENGTH = 500;
const MAX_ROTATION_LOG_BYTES = 50 * 1024 * 1024;

export function writeRotationLog(store: KeyStore, entry: RotationLogEntry): void {
  try {
    store.ensureKeysDir();
    const line = JSON.stringify({
      ...entry,
      message: sanitizeMessage(entry.message),
    });
    rotateLogIfNeeded(store.paths.rotationLogFile, Buffer.byteLength(line) + 1);
    fs.appendFileSync(store.paths.rotationLogFile, `${line}\n`, { mode: 0o600 });
    fs.chmodSync(store.paths.rotationLogFile, 0o600);
  } catch {
    // Diagnostics must never break OpenCode usage.
  }
}

function rotateLogIfNeeded(logFile: string, nextWriteBytes: number): void {
  try {
    const currentBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    if (currentBytes + nextWriteBytes <= MAX_ROTATION_LOG_BYTES) return;

    const rotatedFile = uniqueRotatedLogFile(logFile);
    fs.renameSync(logFile, rotatedFile);
    fs.chmodSync(rotatedFile, 0o600);
  } catch {
    // Best-effort rotation. If it fails, keep logging to the current file.
  }
}

function uniqueRotatedLogFile(logFile: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const base = logFile.replace(/\.jsonl$/, `.${timestamp}.jsonl`);
  if (!fs.existsSync(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = logFile.replace(/\.jsonl$/, `.${timestamp}.${index}.jsonl`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export function readLastRotationDecision(store: KeyStore, providerID?: string): RotationLogEntry | undefined {
  try {
    if (!fs.existsSync(store.paths.rotationLogFile)) return undefined;
    const lines = fs.readFileSync(store.paths.rotationLogFile, "utf8").trim().split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = JSON.parse(lines[index]) as RotationLogEntry;
      if (entry.reason !== "manual_abort" && (!providerID || entry.providerID === providerID)) return entry;
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
