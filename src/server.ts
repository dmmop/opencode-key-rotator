import type { Context as V2Context } from "@opencode-ai/plugin/v2/plugin";
import { resolveOpencodeDataDir } from "./opencode-runtime-paths.js";
import type { KeyStore } from "./key-store.js";
import { rotateProvider } from "./rotation.js";
import { sanitizeRateLimitHeaders, writeRotationLog, type RotationLogEntry } from "./rotation-log.js";
import type { KeyRotatorConfig } from "./config.js";

type ErrorInfo = {
  sessionID?: string;
  attempt?: number;
  eventType?: string;
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
  store?: KeyStore;
  info: ErrorInfo;
  timestamp: string;
  decision: Extract<RotationLogEntry["decision"], "rotated" | "rotated_on_retry">;
  unknownProviderReason: string;
};

type RuntimeContext = {
  session: V2Context["session"];
};

export async function handleEvent(ctx: RuntimeContext, config: KeyRotatorConfig, event: unknown): Promise<void> {
  if (!config.rotation.enabled) return;
  const genericEvent = event as { type: string; data?: Record<string, unknown> };
  if (genericEvent.type === "session.error") {
    await handleSessionError(ctx, config, genericEvent.data);
    return;
  }
  if (isRetryEvent(genericEvent.type)) {
    await handleRetryEvent(ctx, config, genericEvent.type, genericEvent.data);
  }
}

function isRetryEvent(type: string): boolean {
  return type === "session.retry.scheduled" || type === "session.step.failed" || type === "session.execution.failed";
}

async function handleRetryEvent(
  ctx: RuntimeContext,
  config: KeyRotatorConfig,
  eventType: string,
  properties: Record<string, unknown> | undefined,
): Promise<void> {
  const isScheduledRetry = eventType === "session.retry.scheduled";
  const info = normalizeError(properties?.error);
  info.sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
  info.attempt = isScheduledRetry && typeof properties?.attempt === "number" ? properties.attempt : undefined;
  if (typeof properties?.providerID === "string") {
    info.providerID = properties.providerID;
    info.providerSource = "error";
  }
  info.eventType = eventType;

  await retryHandler(
    ctx,
    config,
    info,
    isScheduledRetry ? "retry_error_did_not_match_rotation_patterns" : "failure_error_did_not_match_rotation_patterns",
    isScheduledRetry ? "rotatable_retry_without_provider_id" : "rotatable_failure_without_provider_id",
  );
}

async function retryHandler(
  ctx: RuntimeContext,
  config: KeyRotatorConfig,
  info: ErrorInfo,
  diagReason: string,
  unknownReason: string,
): Promise<void> {
  if (!info.sessionID) return;
  if (!isRotatableError(info, config)) {
    await writeDiagnosticLog(info, new Date().toISOString(), diagReason);
    return;
  }

  await rotateKeyForEvent(ctx, {
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
  const timestamp = new Date().toISOString();

  const store = await createStore();

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

  await rotateKeyForEvent(ctx, {
    store,
    info,
    timestamp,
    decision: "rotated",
    unknownProviderReason: "rotatable_error_without_provider_id",
  });
}

async function rotateKeyForEvent(ctx: RuntimeContext, request: RotationRequest): Promise<void> {
  const store = request.store ?? (await createStore());

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

  rotateProvider(store, request.info.providerID, baseLogEntry(request.info, request.timestamp), request.decision);
}

function baseLogEntry(info: ErrorInfo, timestamp: string): Omit<RotationLogEntry, "decision" | "reason"> {
  return {
    timestamp,
    sessionID: info.sessionID,
    attempt: info.attempt,
    eventType: info.eventType,
    providerID: info.providerID,
    providerSource: info.providerSource,
    errorName: info.name,
    statusCode: info.statusCode,
    message: info.message,
    rateLimitHeaders: sanitizeRateLimitHeaders(info.headers),
  };
}

async function writeDiagnosticLog(info: ErrorInfo, timestamp: string, reason: string): Promise<void> {
  const store = await createStore();
  writeRotationLog(store, {
    ...baseLogEntry(info, timestamp),
    decision: "diagnostic",
    reason,
  });
}

function normalizeError(error: unknown): ErrorInfo {
  if (!error || typeof error !== "object") return { message: String(error) };
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined;

  return {
    name,
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

async function createStore(): Promise<KeyStore> {
  const { createKeyStore } = await import("./key-store.js");
  return createKeyStore(resolveOpencodeDataDir());
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
