import { stdin } from "node:process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { handleEvent } from "./server.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const input = await readStdin();
const event = JSON.parse(input) as unknown;

if (isRecord(event) && typeof event.id === "string") {
  const seenFile = path.join(os.tmpdir(), `opencode-key-rotator-${event.id}.seen`);
  try {
    fs.writeFileSync(seenFile, String(Date.now()), { flag: "wx" });
  } catch {
    process.exit(0);
  }
}

await handleEvent(
  {
    session: {
      get: async () => {
        if (isRecord(event) && isRecord(event.data) && typeof event.data.providerID === "string") {
          return { model: { providerID: event.data.providerID } };
        }
        return {};
      },
    },
  } as never,
  loadConfig(),
  event,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
