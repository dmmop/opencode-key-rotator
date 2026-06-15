#!/usr/bin/env node
import { defaultPluginSpec, updateOpenCodeConfigs } from "./config-installer.js";
function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.action) {
        printHelp();
        process.exit(options.action ? 0 : 1);
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
function parseArgs(args) {
    const options = { spec: defaultPluginSpec(), help: false };
    const [action, ...rest] = args;
    if (action === "init" || action === "remove")
        options.action = action;
    if (action === "help" || action === "--help" || action === "-h")
        options.help = true;
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === "--help" || arg === "-h") {
            options.help = true;
        }
        else if (arg === "--spec") {
            options.spec = requireValue(rest, index, arg);
            index += 1;
        }
        else if (arg === "--config-dir") {
            options.configDir = requireValue(rest, index, arg);
            index += 1;
        }
        else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}
function requireValue(args, index, flag) {
    const value = args[index + 1];
    if (!value)
        throw new Error(`${flag} requires a value`);
    return value;
}
function printHelp() {
    console.log(`Usage:
  opencode-key-rotator init [--spec <plugin-spec>] [--config-dir <dir>]
  opencode-key-rotator remove [--spec <plugin-spec>] [--config-dir <dir>]

Examples:
  opencode-key-rotator init
  opencode-key-rotator init --spec /home/david/Documents/Proyectos/ia_tool/opencode-key-rotator
  opencode-key-rotator remove --spec /home/david/Documents/Proyectos/ia_tool/opencode-key-rotator
`);
}
try {
    main();
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    process.exit(1);
}
//# sourceMappingURL=bin.js.map