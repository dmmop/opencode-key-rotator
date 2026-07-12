import { stdin } from "node:process";
import { loadConfig } from "./config.js";
import { handleEvent } from "./server.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const input = await readStdin();
const event = JSON.parse(input) as unknown;
const config = loadConfig();

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
  config,
  event,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
