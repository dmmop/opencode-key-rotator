#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { updateOpenCodeConfigs, type InstallerAction } from "./config-installer.js";
import { createKeyStore, type KeyStatus, type KeyStore } from "./key-store.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { readLastRotationDecision } from "./rotation-log.js";

type CliOptions = {
  action?: InstallerAction | "switch" | "manage" | "status";
  configDir?: string;
  dataDir?: string;
  providerID?: string;
  alias?: string;
  help: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.action) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  if (options.action === "switch") {
    await switchKey(options);
    return;
  }
  if (options.action === "manage") {
    await manageKeys(options);
    return;
  }
  if (options.action === "status") {
    showStatus(options);
    return;
  }

  const results = updateOpenCodeConfigs({ action: options.action, configDir: options.configDir });
  for (const result of results) {
    const marker = result.changed ? "changed" : "ok";
    console.log(`[${marker}] ${result.message}: ${result.path}`);
  }

  console.log("Restart OpenCode for plugin changes to take effect.");
  if (options.action === "uninstall") console.log("Saved aliases and rotation logs were preserved.");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { help: false };
  const [action, ...rest] = args;
  if (action === "init" || action === "uninstall" || action === "switch" || action === "manage" || action === "status")
    options.action = action;
  if (action === "help" || action === "--help" || action === "-h") options.help = true;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--config-dir") {
      options.configDir = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--provider") {
      options.providerID = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--alias") {
      options.alias = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--data-dir") {
      options.dataDir = requireValue(rest, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function switchKey(options: CliOptions): Promise<void> {
  const store = createKeyStore(options.dataDir ?? getOpencodeRuntimeDirs().dataDir);
  const statuses = store.getStatuses().filter((status) => status.connected && status.aliases.length > 0);
  if (statuses.length === 0) throw new Error("No connected providers with saved aliases were found");

  let readline: Interface | undefined;
  try {
    const providerID =
      options.providerID ??
      (await select(
        (readline ??= interactiveInput()),
        "Provider",
        statuses.map((status) => status.providerID),
      ));
    const status = statuses.find((item) => item.providerID === providerID);
    if (!status) throw new Error(`Provider '${providerID}' is not connected or has no saved aliases`);
    await switchAlias(store, providerID, status.activeAlias, options.alias, () => (readline ??= interactiveInput()));
  } finally {
    readline?.close();
  }
}

async function manageKeys(options: CliOptions): Promise<void> {
  const store = createKeyStore(options.dataDir ?? getOpencodeRuntimeDirs().dataDir);
  const providers = store.listProviderIDs();
  if (providers.length === 0) throw new Error("No connected providers or saved aliases were found");

  const readline = interactiveInput();
  try {
    const providerID = options.providerID ?? (await select(readline, "Provider", providers));
    if (!providers.includes(providerID)) throw new Error(`Provider '${providerID}' was not found`);
    const status = store.getStatuses().find((item) => item.providerID === providerID);
    console.log(`\n${providerID}`);
    console.log(`  Active: ${status?.activeAlias ?? "none"}`);
    console.log(`  Aliases: ${status?.aliases.join(", ") || "none"}`);
    if (status?.synced === false) console.log("  Warning: active credentials changed outside key rotator");

    const action = await select(readline, "Action", ["Save current credential", "Switch alias", "Rename alias", "Delete alias"]);
    if (action === "Save current credential") await saveAlias(store, providerID, readline);
    else if (action === "Switch alias") await switchAlias(store, providerID, status?.activeAlias, undefined, () => readline);
    else if (action === "Rename alias") await renameAlias(store, providerID, readline);
    else await deleteAlias(store, providerID, status?.activeAlias, readline);
  } finally {
    readline.close();
  }
}

function showStatus(options: CliOptions): void {
  const store = createKeyStore(options.dataDir ?? getOpencodeRuntimeDirs().dataDir);
  const statuses = store.getStatuses().filter((status) => !options.providerID || status.providerID === options.providerID);
  console.log("\nKEY ROTATOR STATUS");
  console.log("──────────────────");
  if (statuses.length === 0) {
    console.log(options.providerID ? `⚠ Provider '${options.providerID}' was not found.` : "○ No providers or saved aliases were found.");
    return;
  }

  const rows = statuses.map((status) => ({
    provider: status.providerID,
    active: status.activeAlias ?? "—",
    saved: String(status.aliases.length),
    health: statusHealth(status),
    aliases: status.aliases.join(", ") || "—",
  }));
  const providerWidth = Math.max("Provider".length, ...rows.map((row) => row.provider.length));
  const activeWidth = Math.max("Active".length, ...rows.map((row) => row.active.length));
  const savedWidth = Math.max("Saved".length, ...rows.map((row) => row.saved.length));
  console.log(`${"Provider".padEnd(providerWidth)}  ${"Active".padEnd(activeWidth)}  ${"Saved".padEnd(savedWidth)}  Health`);
  console.log(`${"─".repeat(providerWidth)}  ${"─".repeat(activeWidth)}  ${"─".repeat(savedWidth)}  ${"─".repeat(34)}`);
  for (const row of rows) {
    console.log(`${row.provider.padEnd(providerWidth)}  ${row.active.padEnd(activeWidth)}  ${row.saved.padEnd(savedWidth)}  ${row.health}`);
    console.log(`${" ".repeat(providerWidth + activeWidth + savedWidth + 6)}  aliases: ${row.aliases}`);
  }

  const last = readLastRotationDecision(store, options.providerID);
  console.log("\nLAST AUTOMATIC ROTATION");
  console.log("───────────────────────");
  if (!last) {
    console.log("○ No automatic rotations recorded.");
    return;
  }
  console.log(`${last.decision.startsWith("rotated") ? "✓" : "○"} ${formatWords(last.decision)} · ${last.providerID ?? "unknown"}`);
  console.log(`  ${last.timestamp}`);
  if (last.activeAlias || last.nextAlias) console.log(`  ${last.activeAlias ?? "—"}  →  ${last.nextAlias ?? "—"}`);
  console.log(`  ${formatWords(last.reason)}`);
}

function statusHealth(status: KeyStatus): string {
  if (status.synced === false) return "⚠ Credentials changed outside key rotator";
  if (!status.connected) return "○ Not connected";
  if (status.aliases.length === 0) return "○ No saved aliases";
  if (!status.activeAlias) return "○ No active alias";
  return "✓ Ready";
}

function formatWords(value: string): string {
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function saveAlias(store: KeyStore, providerID: string, readline: Interface): Promise<void> {
  const alias = (await readline.question("Alias: ")).trim();
  if (!alias) throw new Error("Alias cannot be empty");
  if (store.listKeys(providerID).some((key) => key.alias === alias) && !(await confirm(readline, `Overwrite ${providerID}/${alias}?`)))
    return;
  const result = store.saveCurrentProviderKey(providerID, alias, true);
  console.log(`${providerID}/${alias} saved${result.replaced ? " and updated" : ""} as active.`);
}

async function switchAlias(
  store: KeyStore,
  providerID: string,
  activeAlias: string | undefined,
  requestedAlias: string | undefined,
  getReadline: () => Interface,
): Promise<void> {
  const aliases = store
    .listKeys(providerID)
    .map((key) => key.alias)
    .filter((alias) => alias !== activeAlias);
  if (aliases.length === 0) throw new Error(`Provider '${providerID}' has no alternative aliases`);
  const alias = requestedAlias ?? (await select(getReadline(), `Alias for ${providerID} (active: ${activeAlias ?? "none"})`, aliases));
  if (!aliases.includes(alias)) {
    if (alias === activeAlias) throw new Error(`Alias '${providerID}/${alias}' is already active`);
    throw new Error(`Alias '${providerID}/${alias}' was not found`);
  }
  const result = store.switchProviderKey(providerID, alias, "cli-switch");
  console.log(`${providerID}: ${result.previousAlias ?? "none"} -> ${result.activeAlias}`);
}

async function renameAlias(store: KeyStore, providerID: string, readline: Interface): Promise<void> {
  const aliases = store.listKeys(providerID).map((key) => key.alias);
  if (aliases.length === 0) throw new Error(`Provider '${providerID}' has no saved aliases`);
  const alias = await select(readline, "Alias to rename", aliases);
  const newAlias = (await readline.question("New alias: ")).trim();
  if (!newAlias) throw new Error("Alias cannot be empty");
  store.renameProviderKey(providerID, alias, newAlias);
  console.log(`${providerID}/${alias} -> ${newAlias}`);
}

async function deleteAlias(store: KeyStore, providerID: string, activeAlias: string | undefined, readline: Interface): Promise<void> {
  const aliases = store
    .listKeys(providerID)
    .map((key) => key.alias)
    .filter((alias) => alias !== activeAlias);
  if (aliases.length === 0) throw new Error(`Provider '${providerID}' has no aliases that can be deleted`);
  const alias = await select(readline, "Alias to delete", aliases);
  if (!(await confirm(readline, `Delete ${providerID}/${alias}?`))) return;
  store.deleteProviderKey(providerID, alias);
  console.log(`${providerID}/${alias} deleted.`);
}

function interactiveInput(): Interface {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive selection requires a terminal");
  return createInterface({ input: process.stdin, output: process.stdout });
}

async function select(readline: Interface, label: string, values: string[]): Promise<string> {
  console.log(`${label}:`);
  values.forEach((value, index) => console.log(`  ${index + 1}. ${value}`));
  const answer = await readline.question("Select a number: ");
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new Error("Invalid selection");
  return values[index];
}

async function confirm(readline: Interface, message: string): Promise<boolean> {
  return /^y(?:es)?$/i.test((await readline.question(`${message} [y/N] `)).trim());
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  opencode-key-rotator init [--config-dir <dir>]
  opencode-key-rotator uninstall [--config-dir <dir>]
  opencode-key-rotator switch [--provider <id>] [--alias <alias>] [--data-dir <dir>]
  opencode-key-rotator manage [--provider <id>] [--data-dir <dir>]
  opencode-key-rotator status [--provider <id>] [--data-dir <dir>]

Examples:
  opencode-key-rotator init
  opencode-key-rotator uninstall
  opencode-key-rotator switch
  opencode-key-rotator manage
  opencode-key-rotator status
`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exit(1);
}
