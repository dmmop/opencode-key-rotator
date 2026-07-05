# opencode-key-rotator

[![npm version](https://img.shields.io/npm/v/opencode-key-rotator)](https://www.npmjs.com/package/opencode-key-rotator)
[![npm downloads](https://img.shields.io/npm/dm/opencode-key-rotator)](https://www.npmjs.com/package/opencode-key-rotator)
[![CI](https://github.com/dmmop/opencode-key-rotator/actions/workflows/ci.yml/badge.svg)](https://github.com/dmmop/opencode-key-rotator/actions/workflows/ci.yml)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Reactive OpenCode plugin that automatically rotates provider API keys on rate limits and quota errors, with built-in TUI key management.

Automatically swaps to the next saved key when OpenCode encounters rate limits (429), quota exhaustion, or resource errors during sessions.

## Features

- **Automatic rotation** — detects rate-limit and quota errors and swaps to the next available key on retry
- **TUI key manager** — interactive terminal UI to manage provider keys with per-provider grouping
- **OpenCode plugin** — integrates as a server plugin with no manual setup after initial configuration
- **Persistent storage** — keys and rotation logs stored in the XDG data directory
- **Configurable** — customize rotation patterns, dedup window, backups, and toast duration via sidecar config
- **Secure** — atomic writes, restrictive permissions, and log sanitization for credentials

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

Add the plugin to **both** `opencode.json` and `tui.json` in your OpenCode config directory:

**opencode.json:**

```jsonc
{
  "plugin": ["opencode-key-rotator"],
}
```

**tui.json:**

```jsonc
{
  "plugin": ["opencode-key-rotator"],
}
```

Both files are required: `opencode.json` loads the server-side plugin (event handlers, key rotation pipeline), and `tui.json` loads the TUI-side plugin (slash commands `/key-save`, `/key-switch`, `/key-status`).

### Uninstall

```bash
npx -y opencode-key-rotator remove
```

Saved keys and rotation logs are preserved on removal.

## CLI

```
opencode-key-rotator init [--spec <plugin-spec>] [--config-dir <dir>]
opencode-key-rotator remove [--spec <plugin-spec>] [--config-dir <dir>]
```

## TUI Commands

| Command       | Description                                            |
| ------------- | ------------------------------------------------------ |
| `/key-save`   | Save the current provider credentials as a named alias |
| `/key-switch` | Switch the active key to another saved alias           |
| `/key-status` | Show provider statuses and the last rotation event     |

## Configuration

Create a sidecar config file at `~/.config/opencode/opencode-key-rotator/config.json`:

```json
{
  "rotation": {
    "enabled": true,
    "patterns": ["\\b429\\b", "rate\\s*limit", "quota", "resource exhausted", "usage limit", "insufficient quota"]
  },
  "storage": {
    "maxBackups": 10,
    "lockTtlMs": 30000
  },
  "ui": {
    "toastDurationMs": 11000
  }
}
```

The config file supports JSONC (comments and trailing commas). Resolution order:

1. `${configDir}/opencode-key-rotator/config.json`
2. Built-in defaults

## How rotation works

1. OpenCode emits `session.next.retried` when a request is retried. The plugin rotates on `attempt === 1` if the error message matches the configured patterns.
2. If rotation did not happen early, `session.error` acts as a fallback. The plugin rotates on HTTP 429 or matching messages.
3. The provider is inferred from session messages first, then from the configured model.
4. If at least two keys are saved for the provider, the plugin switches to the next alias in a round-robin cycle.
5. If a rotated key fails on the next attempt, that alias enters a 2-minute cooldown and is skipped during subsequent rotations.
6. Before switching, the current credentials are saved under the previous alias so you can roll back.
7. Every decision is recorded in `~/.local/share/opencode/keys/rotation.log.jsonl`.

## Data layout

```
~/.local/share/opencode/
  auth.json                        # Active OpenCode credentials
  keys/
    active.json                    # Active alias metadata per provider
    rotation.log.jsonl             # Rotation decisions (JSON Lines)
    .lock                          # Concurrency lock file
    backups/                       # auth.json backups before rotation
    <providerID>/                  # e.g. openai/, anthropic/
      <alias>.json                 # Saved credential snapshots
```

## Troubleshooting

| Symptom                                          | Cause                                                                               | Fix                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| `"OpenCode auth file was not found"` error       | `auth.json` does not exist                                                          | Run `/connect` in OpenCode and then `/key-save` |
| `active credentials changed outside key rotator` | The provider credentials in `auth.json` no longer match the saved alias fingerprint | Re-run `/key-save` for the active alias         |
| `Provider unknown`                               | The plugin could not infer the provider from session messages or config             | Ensure the model is set (e.g. `openai/gpt-4`)   |
| `No fallback key`                                | Only one key is saved for the provider                                              | Save at least two aliases with `/key-save`      |
| `All keys cooling down`                          | All saved aliases are in cooldown after failed attempts                             | Wait 2 minutes or save additional aliases       |

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
