import type { Context as V2Context } from "@opencode-ai/plugin/v2/plugin";
import { resolveOpencodeDataDir } from "./opencode-runtime-paths.js";
import { KeyStoreError } from "./errors.js";
import type { KeyStore } from "./key-store.js";
import { sanitizeRateLimitHeaders, writeRotationLog, type RotationLogEntry } from "./rotation-log.js";
import type { KeyRotatorConfig } from "./config.js";

type ErrorInfo = {
  sessionID?: string;
  attempt?: number;
  eventType?: string;
  propertyKeys?: string[];
  errorKeys?: string[];
  errorDataKeys?: string[];
  payload?: unknown;
  name?: string;
  providerID?: string;
  providerSource?: ProviderSource;
  statusCode?: number;
  message?: string;
  headers?: Record<string, string>;
};

type ProviderSource = "error" | "session_model";

type InferredProvider = {
  providerID: string;
  source: ProviderSource;
};

type RotationRequest = {
  sessionID?: string;
  store?: KeyStore;
  info: ErrorInfo;
  timestamp: string;
  decision: Extract<RotationLogEntry["decision"], "rotated" | "rotated_on_retry">;
  unknownProviderReason: string;
};

type RuntimeContext = {
  session: V2Context["session"];
};

const FAILED_ALIAS_COOLDOWN_MS = 2 * 60 * 1_000;
const failedAliasCooldowns = new Map<string, Map<string, number>>();

function toLocalISOString(date: number | Date): string {
  const d = typeof date === "number" ? new Date(date) : date;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const tzSign = offsetMinutes >= 0 ? "+" : "-";
  const tzHours = pad2(Math.floor(Math.abs(offsetMinutes) / 60));
  const tzMins = pad2(Math.abs(offsetMinutes) % 60);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${tzSign}${tzHours}:${tzMins}`;
}

export async function handleEvent(ctx: RuntimeContext, config: KeyRotatorConfig, event: unknown): Promise<void> {
  const genericEvent = event as { type: string; data?: Record<string, unknown> };
  if (genericEvent.type === "session.retry.scheduled") {
    await handleSessionRetryScheduled(ctx, config, genericEvent.data);
    return;
  }
  if (genericEvent.type === "session.error") {
    await handleSessionError(ctx, config, genericEvent.data);
    return;
  }
  if (genericEvent.type === "session.step.failed" || genericEvent.type === "session.execution.failed") {
    await handleSessionFailure(ctx, config, genericEvent.type, genericEvent.data);
  }
}

async function handleSessionFailure(
  ctx: RuntimeContext,
  config: KeyRotatorConfig,
  eventType: string,
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
  const info = normalizeRetryError(properties?.error);
  info.sessionID = sessionID;
  if (typeof properties?.providerID === "string") {
    info.providerID = properties.providerID;
    info.providerSource = "error";
  }
  info.eventType = eventType;
  info.propertyKeys = sortedKeys(properties);
  info.payload = properties;

  await retryHandler(ctx, config, info, "failure_error_did_not_match_rotation_patterns", "rotatable_failure_without_provider_id");
}

async function handleSessionRetryScheduled(
  ctx: RuntimeContext,
  config: KeyRotatorConfig,
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
  const info = normalizeRetryError(properties?.error);
  info.sessionID = sessionID;
  info.attempt = typeof properties?.attempt === "number" ? properties.attempt : undefined;
  if (typeof properties?.providerID === "string") {
    info.providerID = properties.providerID;
    info.providerSource = "error";
  }
  info.eventType = "session.retry.scheduled";
  info.propertyKeys = sortedKeys(properties);
  info.payload = properties;

  await retryHandler(ctx, config, info, "retry_error_did_not_match_rotation_patterns", "rotatable_retry_without_provider_id");
}

async function retryHandler(
  ctx: RuntimeContext,
  config: KeyRotatorConfig,
  info: ErrorInfo,
  diagReason: string,
  unknownReason: string,
): Promise<void> {
  if (!info.sessionID) return;
  if (!info.message || !isRotatableMessage(info.message, config)) {
    await writeDiagnosticLog(config, info, new Date().toISOString(), diagReason);
    return;
  }

  await rotateKeyForEvent(ctx, config, {
    sessionID: info.sessionID,
    info,
    timestamp: new Date().toISOString(),
    decision: "rotated_on_retry",
    unknownProviderReason: unknownReason,
  });
}

async function handleSessionError(
  ctx: RuntimeContext,
  config: KeyRotatorConfig,
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const error = properties?.error;
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
  const info = normalizeError(error);
  info.sessionID = sessionID;
  info.eventType = "session.error";
  info.propertyKeys = sortedKeys(properties);
  info.payload = properties;
  const timestamp = new Date().toISOString();

  const store = await createStore(config);
  if (!store) return;

  if (info.name === "MessageAbortedError") {
    writeRotationLog(store, { ...baseLogEntry(info, timestamp), decision: "ignored", reason: "manual_abort" });
    return;
  }

  if (!isRotatableError(info, config)) {
    writeRotationLog(store, {
      ...baseLogEntry(info, timestamp),
      decision: "not_rotatable",
      reason: "error_did_not_match_rotation_patterns",
    });
    return;
  }

  await rotateKeyForEvent(ctx, config, {
    sessionID,
    store,
    info,
    timestamp,
    decision: "rotated",
    unknownProviderReason: "rotatable_error_without_provider_id",
  });
}

async function rotateKeyForEvent(
  ctx: RuntimeContext,
  config: KeyRotatorConfig,
  request: RotationRequest,
): Promise<void> {
  const store = request.store ?? (await createStore(config));
  if (!store) return;

  if (!request.info.providerID) {
    const inferred = await inferProvider(ctx, request.info);
    if (inferred) {
      request.info.providerID = inferred.providerID;
      request.info.providerSource = inferred.source;
    }
  }

  if (!request.info.providerID) {
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: "provider_unknown",
      reason: request.unknownProviderReason,
    });
    return;
  }

  const providerID = request.info.providerID;
  const keys = store.listKeys(providerID);
  if (keys.length < 2) {
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: "no_alternative",
      reason: "provider_has_less_than_two_saved_keys",
    });
    return;
  }

  const currentAlias = store.readActiveAliases()[providerID];
  const cooldownKey = providerCooldownKey(store, providerID);
  const now = new Date();
  const cooldownMs = computeCooldownMs(request.info.headers);
  if (currentAlias) {
    const expiresAt = markAliasCoolingDown(cooldownKey, currentAlias, cooldownMs);
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: "diagnostic",
      reason: "alias_entered_cooldown",
      coolingDownAlias: currentAlias,
      cooldownEnteredAt: toLocalISOString(now),
      cooldownExpiresAt: toLocalISOString(expiresAt),
      cooldownMs: cooldownMs,
    });
  }

  const nextAlias = nextAvailableAlias(
    cooldownKey,
    keys.map((key) => key.alias),
    currentAlias,
  );
  if (!nextAlias) {
    const cooldowns = failedAliasCooldowns.get(cooldownKey);
    const cooldownState: string[] = [];
    if (cooldowns) {
      for (const [alias, expiresAt] of cooldowns) {
        cooldownState.push(`${alias}: expires ${toLocalISOString(expiresAt)}`);
      }
    }
    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: "all_keys_cooling_down",
      reason: "all_saved_keys_are_cooling_down",
      activeAlias: currentAlias,
      cooldownState: cooldownState.length ? cooldownState.join(", ") : undefined,
    });
    return;
  }

  try {
    const result = store.switchProviderKey(providerID, nextAlias, "auto-rotate");

    writeRotationLog(store, {
      ...baseLogEntry(request.info, request.timestamp),
      decision: request.decision,
      reason: "matched_rotation_patterns",
      activeAlias: result.previousAlias,
      nextAlias: result.activeAlias,
    });
  } catch (rotationError) {
    await logRotationError(
      config,
      store,
      request.info.providerID,
      request.info.providerSource,
      request.info.message,
      request.timestamp,
      rotationError,
    );
  }
}

function providerCooldownKey(store: KeyStore, providerID: string): string {
  return `${store.paths.dataDir}\0${providerID}`;
}

function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return undefined;
  const asSeconds = Number(raw);
  if (!Number.isNaN(asSeconds)) return asSeconds * 1_000;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return Math.max(0, parsed - Date.now());
  return undefined;
}

function computeCooldownMs(headers: Record<string, string> | undefined): number {
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs !== undefined) {
    return Math.max(FAILED_ALIAS_COOLDOWN_MS, retryAfterMs);
  }
  return FAILED_ALIAS_COOLDOWN_MS;
}

function markAliasCoolingDown(cooldownKey: string, alias: string, cooldownMs: number = FAILED_ALIAS_COOLDOWN_MS): number {
  let providerCooldowns = failedAliasCooldowns.get(cooldownKey);
  if (!providerCooldowns) {
    providerCooldowns = new Map<string, number>();
    failedAliasCooldowns.set(cooldownKey, providerCooldowns);
  }
  const expiresAt = Date.now() + cooldownMs;
  providerCooldowns.set(alias, expiresAt);
  return expiresAt;
}

function nextAvailableAlias(cooldownKey: string, aliases: string[], currentAlias: string | undefined): string | undefined {
  const providerCooldowns = failedAliasCooldowns.get(cooldownKey);
  const now = Date.now();
  if (providerCooldowns) {
    for (const [alias, cooldownUntil] of providerCooldowns) {
      if (cooldownUntil <= now) providerCooldowns.delete(alias);
    }
    if (providerCooldowns.size === 0) failedAliasCooldowns.delete(cooldownKey);
  }

  const currentIndex = currentAlias ? aliases.indexOf(currentAlias) : -1;
  for (let offset = 1; offset <= aliases.length; offset += 1) {
    const alias = aliases[(currentIndex + offset + aliases.length) % aliases.length];
    if (alias !== currentAlias && !providerCooldowns?.has(alias)) return alias;
  }
  return undefined;
}

function baseLogEntry(info: ErrorInfo, timestamp: string): Omit<RotationLogEntry, "decision" | "reason"> {
  return {
    timestamp,
    sessionID: info.sessionID,
    attempt: info.attempt,
    eventType: info.eventType,
    propertyKeys: info.propertyKeys,
    errorKeys: info.errorKeys,
    errorDataKeys: info.errorDataKeys,
    payload: info.payload,
    providerID: info.providerID,
    providerSource: info.providerSource,
    errorName: info.name,
    statusCode: info.statusCode,
    message: info.message,
    rateLimitHeaders: sanitizeRateLimitHeaders(info.headers),
  };
}

async function writeDiagnosticLog(
  config: KeyRotatorConfig,
  info: ErrorInfo,
  timestamp: string,
  reason: string,
): Promise<void> {
  const store = await createStore(config);
  if (!store) return;
  writeRotationLog(store, {
    ...baseLogEntry(info, timestamp),
    decision: "diagnostic",
    reason,
  });
}

async function logRotationError(
  config: KeyRotatorConfig,
  store: KeyStore,
  providerID: string,
  providerSource: ProviderSource | undefined,
  message: string | undefined,
  timestamp: string,
  rotationError: unknown,
): Promise<void> {
  const errorMessage = rotationError instanceof Error ? rotationError.message : String(rotationError);
  const activeAlias = readActiveAliasSafely(store, providerID);
  const fingerprintMismatch = errorMessage.includes("no longer match alias");
  writeRotationLog(store, {
    timestamp,
    providerID,
    providerSource,
    message: `${message ?? ""}\nrotation_error=${errorMessage}`,
    decision: fingerprintMismatch ? "fingerprint_mismatch" : "error",
    reason: fingerprintMismatch
      ? "active_credentials_changed_outside_plugin"
      : rotationError instanceof KeyStoreError
        ? "key_store_error"
        : "unexpected_rotation_error",
    activeAlias,
  });
}

function normalizeError(error: unknown): ErrorInfo {
  if (!error || typeof error !== "object") return { message: String(error) };
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined;

  return {
    errorKeys: sortedKeys(record),
    errorDataKeys: sortedKeys(data),
    name,
    providerID: typeof data?.providerID === "string" ? data.providerID : undefined,
    providerSource: typeof data?.providerID === "string" ? "error" : undefined,
    statusCode: readStatusCode(record, data),
    message: extractErrorMessage(record, data),
    headers:
      data?.responseHeaders && typeof data.responseHeaders === "object" ? (data.responseHeaders as Record<string, string>) : undefined,
  };
}

function normalizeRetryError(error: unknown): ErrorInfo {
  if (!error || typeof error !== "object") return { message: String(error) };
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined;
  return {
    errorKeys: sortedKeys(record),
    errorDataKeys: sortedKeys(data),
    name: typeof record.name === "string" ? record.name : undefined,
    providerID: typeof data?.providerID === "string" ? data.providerID : undefined,
    providerSource: typeof data?.providerID === "string" ? "error" : undefined,
    statusCode: readStatusCode(record, data),
    message: extractErrorMessage(record, data),
    headers:
      data?.responseHeaders && typeof data.responseHeaders === "object" ? (data.responseHeaders as Record<string, string>) : undefined,
  };
}

function extractErrorMessage(record: Record<string, unknown>, data: Record<string, unknown> | undefined): string | undefined {
  if (typeof data?.message === "string") return data.message;
  if (typeof record.message === "string") return record.message;
  if (typeof record.type === "string") return record.type;
  if (typeof record.error === "string") return record.error;
  return undefined;
}

function readStatusCode(record: Record<string, unknown>, data: Record<string, unknown> | undefined): number | undefined {
  if (typeof data?.statusCode === "number") return data.statusCode;
  if (typeof record.statusCode === "number") return record.statusCode;
  if (typeof record.status === "number") return record.status;
  return undefined;
}

function sortedKeys(record: Record<string, unknown> | undefined): string[] | undefined {
  if (!record) return undefined;
  const keys = Object.keys(record).sort();
  return keys.length > 0 ? keys : undefined;
}

async function inferProvider(ctx: RuntimeContext, info: ErrorInfo): Promise<InferredProvider | undefined> {
  if (info.providerID) return { providerID: info.providerID, source: info.providerSource ?? "error" };
  if (!info.sessionID) return undefined;
  if (!ctx.session?.get) return undefined;
  try {
    const session = await ctx.session.get({ sessionID: info.sessionID });
    const providerID = session.model?.providerID;
    return providerID ? { providerID, source: "session_model" } : undefined;
  } catch {
    return undefined;
  }
}

async function createStore(config: KeyRotatorConfig): Promise<KeyStore> {
  const { createKeyStore } = await import("./key-store.js");
  return createKeyStore(resolveOpencodeDataDir(), config);
}

function readActiveAliasSafely(store: KeyStore, providerID: string | undefined): string | undefined {
  if (!providerID) return undefined;
  try {
    return store.readActiveAliases()[providerID];
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRotatableError(info: ErrorInfo, config: KeyRotatorConfig): boolean {
  if (info.name === "MessageOutputLengthError") return false;
  if (info.statusCode === 429) return true;
  return isRotatableMessage(info.message, config);
}

function isRotatableMessage(message: string | undefined, config: KeyRotatorConfig): boolean {
  if (!message) return false;
  return config.rotation.patterns.some((pattern) => pattern.test(message));
}
