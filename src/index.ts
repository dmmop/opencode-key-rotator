import { Plugin } from "@opencode-ai/plugin/v2";
import type { Context } from "@opencode-ai/plugin/v2/plugin";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { handleEvent } from "./server.js";

const handledEventIDs = new Set<string>();

export default Plugin.define({
  id: "opencode-key-rotator",
  setup: async (ctx) => {
    appendFileSync("/tmp/opencode-key-rotator-events.log", `${new Date().toISOString()} setup\n`);
    const config = loadConfig();

    if (!config.rotation.enabled) return;

    let disposed = false;
    void (async () => {
      for await (const event of ctx.event.subscribe()) {
        if (disposed) break;
        if (isDuplicateEvent(event)) continue;
        if (!isRotationEvent(event)) continue;
        appendFileSync("/tmp/opencode-key-rotator-events.log", `${new Date().toISOString()} ${event.type}\n`);
        appendFileSync("/tmp/opencode-key-rotator-events.log", `${JSON.stringify(event)}\n`);
        if (isBunRuntime()) {
          await runNodeEventHandler(await enrichEvent(ctx, event));
          continue;
        }
        await handleEvent(ctx, config, event);
      }
    })().catch((error) => {
      console.warn(`[opencode-key-rotator] event stream stopped: ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      disposed = true;
    };
  },
});

function isRotationEvent(event: { type?: string }): boolean {
  return (
    event.type === "session.retry.scheduled" ||
    event.type === "session.error" ||
    event.type === "session.step.failed" ||
    event.type === "session.execution.failed"
  );
}

function isDuplicateEvent(event: { id?: string }): boolean {
  if (!event.id) return false;
  if (handledEventIDs.has(event.id)) return true;
  handledEventIDs.add(event.id);
  if (handledEventIDs.size > 1_000) handledEventIDs.clear();
  return false;
}

function isBunRuntime(): boolean {
  return "Bun" in globalThis;
}

async function enrichEvent(ctx: Context, event: unknown): Promise<unknown> {
  if (!isRecord(event) || !isRecord(event.data)) return event;
  const sessionID = typeof event.data.sessionID === "string" ? event.data.sessionID : undefined;
  if (!sessionID) return event;
  try {
    const session = await ctx.session.get({ sessionID });
    const providerID = session.model?.providerID;
    if (!providerID) return event;
    return { ...event, data: { ...event.data, providerID } };
  } catch {
    return event;
  }
}

async function runNodeEventHandler(event: unknown): Promise<void> {
  const runner = join(dirname(fileURLToPath(import.meta.url)), "node-event-runner.js");
  await new Promise<void>((resolve) => {
    const child = spawn("node", [runner], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        appendFileSync("/tmp/opencode-key-rotator-events.log", `${new Date().toISOString()} node-handler-exit ${code}: ${stderr}\n`);
      }
      resolve();
    });
    child.stdin.end(JSON.stringify(event));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
