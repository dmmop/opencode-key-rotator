# opencode-key-rotator

OpenCode V2 credentials, aliases, and active metadata are stored in `opencode-next.db`.
[![npm version](https://img.shields.io/npm/v/opencode-key-rotator)](https://www.npmjs.com/package/opencode-key-rotator)
[![npm downloads](https://img.shields.io/npm/dm/opencode-key-rotator)](https://www.npmjs.com/package/opencode-key-rotator)
[![CI](https://github.com/dmmop/opencode-key-rotator/actions/workflows/ci.yml/badge.svg)](https://github.com/dmmop/opencode-key-rotator/actions/workflows/ci.yml)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenCode v2 plugin that automatically rotates provider API keys on rate limits and quota errors.

Automatically swaps to the next saved key when OpenCode encounters rate limits (429), quota exhaustion, or resource errors during sessions.

## Features

- **Automatic rotation** — detects rate-limit and quota errors and swaps to the next available key on retry
- **OpenCode v2 plugin** — subscribes to public session events with one native v2 entrypoint
- **Persistent storage** — keys and rotation logs stored in the XDG data directory
- **Configurable** — customize rotation patterns via a sidecar config
- **Secure** — transactional SQLite writes, restrictive permissions, and credential log sanitization

## Installation

```bash
npx -y opencode-key-rotator init
```

Or install it globally:

```bash
npm install -g opencode-key-rotator
opencode-key-rotator init
```

## Setup

### Automatic (recommended)

Run the init command to register the plugin in your OpenCode config and create a default sidecar config:

```bash
npx -y opencode-key-rotator init
```

### Manual

Add the plugin to your OpenCode V2 config:

**opencode.json:**

```jsonc
{
  "plugins": ["opencode-key-rotator"],
}
```

### Uninstall

```bash
npx -y opencode-key-rotator uninstall
```

Saved keys and rotation logs are preserved on removal.

## CLI

```
opencode-key-rotator init [--config-dir <dir>]
opencode-key-rotator uninstall [--config-dir <dir>]
opencode-key-rotator switch [--provider <id>] [--alias <alias>] [--data-dir <dir>]
opencode-key-rotator manage [--provider <id>] [--data-dir <dir>]
opencode-key-rotator status [--provider <id>] [--data-dir <dir>]
```

## Key management

Use `opencode-key-rotator switch` for an interactive provider and alias selector. Pass `--provider` and `--alias` to use it non-interactively.

Use `opencode-key-rotator manage` for an interactive local workflow that saves the current credential, switches aliases, renames aliases, and deletes inactive aliases. It does not use the agent.

Use `opencode-key-rotator status` to list aliases, synchronization health, and the latest automatic rotation recorded in `rotation.log.jsonl`.

The server only translates OpenCode events. Rotation policy, cooldowns, switching, and automatic rotation logs live in `rotation.ts`, while SQLite CRUD lives in `key-store.ts`; the CLI and future TUI call the same core operations.

The package also keeps a provisional `./tui` V1 adapter for `/key-save`, `/key-switch`, and `/key-status`. It contains only TUI registration/rendering and calls the same core; migration to the final V2 TUI API will be isolated to `src/tui.ts`.

## Configuration

Create a sidecar config file at `~/.config/opencode/opencode-key-rotator/config.json`:

```json
{
  "rotation": {
    "enabled": true,
    "patterns": ["\\b429\\b", "rate\\s*limit", "quota", "resource exhausted", "usage limit", "insufficient quota"]
  }
}
```

The config file supports JSONC (comments and trailing commas). Resolution order:

1. `${configDir}/opencode-key-rotator/config.json`
2. Built-in defaults

## How rotation works

1. The plugin handles `session.retry.scheduled` events and evaluates every retry whose status is 429 or whose message matches the configured patterns.
2. `session.error` is a fallback and rotates on HTTP 429 or matching messages.
3. The provider comes from the event payload or the session model.
4. If at least two keys are saved for the provider, the plugin switches to the next alias in a round-robin cycle.
5. If a rotated key fails on the next attempt, that alias enters a 2-minute cooldown and is skipped during subsequent rotations.
6. Before switching, the current credentials are saved under the previous alias.
7. Every decision is recorded in `~/.local/share/opencode/keys/rotation.log.jsonl`.

## Data layout

```
~/.local/share/opencode/
  opencode-next.db                 # OpenCode credentials plus plugin alias metadata
  keys/
    rotation.log.jsonl             # Rotation decisions (JSON Lines)
```

## Troubleshooting

| Symptom                 | Cause                                                   | Fix                                       |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------- |
| `Provider unknown`      | The v2 event did not expose a provider ID               | Check the provider event data             |
| `No fallback key`       | Only one key is saved for the provider                  | Save another alias                        |
| `All keys cooling down` | All saved aliases are in cooldown after failed attempts | Wait 2 minutes or save additional aliases |

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
npm run format
```

## Releasing

A maintainer can trigger a fully automated release from GitHub Actions:

1. Go to **Actions** → **Release** → **Run workflow**
2. Choose `patch`, `minor`, or `major`
3. The workflow will:
   - Run the full test suite
   - Bump the version in `package.json`
   - Create and push a Git tag
   - Create a GitHub Release with auto-generated notes
   - Publish the package to npm via Trusted Publishing

## License

MIT
