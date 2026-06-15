# opencode-key-rotator

Reactive OpenCode provider credential rotation with TUI key management.

Automatically rotates provider API keys when OpenCode encounters rate limits (429), quota exhaustion, or auth errors during sessions.

## Features

- **Automatic rotation** — detects rate-limit and auth errors and swaps to the next available key on retry
- **TUI key manager** — interactive terminal UI to manage provider keys with masked values and per-provider grouping
- **OpenCode plugin** — integrates as a server plugin with no manual setup after initial configuration
- **Persistent storage** — keys and rotation logs stored in the XDG data directory

## Installation

```bash
npm install -g opencode-key-rotator
```

Or use directly with `npx`:

```bash
npx opencode-key-rotator init
```

## Setup

### Automatic (recommended)

Run the init command to register the plugin in your OpenCode config:

```bash
opencode-key-rotator init
```

### Manual

Add the plugin to your OpenCode `opencode.jsonc` config:

```jsonc
{
  "plugins": [
    {
      "from": "opencode-key-rotator",
      "params": {
        "server": true,
        "tui": true
      }
    }
  ]
}
```

### Uninstall

```bash
opencode-key-rotator remove
```

Saved keys and rotation logs are preserved on removal.

## Usage

1. Start OpenCode — the plugin runs automatically on the server side
2. Use the TUI to add provider keys:
   - Open a terminal and run the TUI from OpenCode's command palette
   - Set one or more keys per provider
   - Mark keys as primary or secondary fallbacks
3. When a provider returns a 429, rate-limit, or auth error during a session:
   - The plugin logs the error details
   - On retry, the next key is automatically rotated in
   - All rotation events are recorded in the rotation log

## CLI

```
opencode-key-rotator init [--spec <plugin-spec>] [--config-dir <dir>]
opencode-key-rotator remove [--spec <plugin-spec>] [--config-dir <dir>]
```

## License

MIT
