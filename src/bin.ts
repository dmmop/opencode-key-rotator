#!/usr/bin/env node
import { defaultPluginSpec, updateOpenCodeConfigs, type InstallerAction } from "./config-installer.js";
import { migrateLegacy } from "./migration.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

type CliOptions = {
  action?: InstallerAction | "migrate";
  spec: string;
  configDir?: string;
  help: boolean;
  providerID?: string;
  methodID?: string;
  dataDir?: string;
  dbFile?: string;
  dryRun: boolean;
};

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.action) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  if (options.action === "migrate") {
    const report = migrateLegacy({
      dataDir: options.dataDir ?? getOpencodeRuntimeDirs().dataDir,
      providerID: options.providerID,
      methodID: options.methodID,
      dbFile: options.dbFile,
      dryRun: options.dryRun,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const results = updateOpenCodeConfigs({
    action: options.action,
    spec: options.spec,
    configDir: options.configDir,
  });

  for (const result of results) {
    const marker = result.changed ? "changed" : "ok";
    console.log(`[${marker}] ${result.message}: ${result.path}`);
  }

  console.log("Restart OpenCode for plugin changes to take effect.");
  if (options.action === "remove") {
    console.log("Saved keys and rotation logs were preserved.");
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { spec: defaultPluginSpec(), help: false, dryRun: false };
  const [action, ...rest] = args;
  if (action === "init" || action === "remove" || action === "migrate") options.action = action;
  if (action === "help" || action === "--help" || action === "-h") options.help = true;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--spec") {
      options.spec = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--config-dir") {
      options.configDir = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--provider") {
      options.providerID = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--method-id") {
      options.methodID = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--data-dir") {
      options.dataDir = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--db-file") {
      options.dbFile = requireValue(rest, index, arg);
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  opencode-key-rotator init [--spec <plugin-spec>] [--config-dir <dir>]
  opencode-key-rotator remove [--spec <plugin-spec>] [--config-dir <dir>]
  opencode-key-rotator migrate [--provider <id>] [--method-id <id>] [--data-dir <dir>] [--db-file <path>] [--dry-run]

Examples:
  opencode-key-rotator init
  opencode-key-rotator init --spec /home/david/Documents/Proyectos/ia_tool/opencode-key-rotator
  opencode-key-rotator remove --spec /home/david/Documents/Proyectos/ia_tool/opencode-key-rotator
`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exit(1);
}
