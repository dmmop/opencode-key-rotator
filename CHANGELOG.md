# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### OpenCode V2

- Replaced previous entrypoints with the documented OpenCode V2 `Plugin.define({ id, setup })` entrypoint.
- The installer now edits the documented OpenCode V2 config shape: `plugins` in `opencode.json`.
- Credentials now use OpenCode's `credential` SQLite table and namespaced alias/active tables.
- OpenCode V2 SQLite is the only supported credential store.
- Node 22.5+ is required for the built-in `node:sqlite` driver.

### Added

- Prettier configuration and formatting checks.
- GitHub Actions CI workflow with typecheck, build, tests, format check, and runtime smoke tests.
- GitHub Actions npm publish workflow with provenance attestations.
- Comprehensive test suite: server integration tests, sanitization tests, CLI tests, and config loader tests.
- Sidecar configuration file at `~/.config/opencode/opencode-key-rotator/config.json`.
- Interactive `switch` CLI with optional non-interactive provider and alias flags.
- Interactive `manage` CLI for save, switch, rename, and delete operations without agent usage.
- Read-only `status` CLI for aliases, synchronization health, and the latest automatic rotation.
- Provisional V1 `./tui` adapter backed by the shared KeyStore and rotation log APIs.
- Expanded README with badges, configuration reference, troubleshooting, and development guide.
- GitHub issue templates for bug reports and feature requests.

### Changed

- The v2 plugin loads configuration and uses configurable rotation patterns and cooldowns.
- SQLite transactions now provide write serialization without a separate lock file.
- Automatic rotation policy and cooldowns now live in `rotation.ts`, separate from the OpenCode event adapter.

### Fixed

- `opencode-key-rotator uninstall` no longer creates empty config files when they do not exist.
- `--help` now exits with code 0.
- `init` preserves an existing sidecar configuration.
- Rotation logs no longer persist event payloads or write raw events to `/tmp`.

## [0.1.1] - 2026-06-15

### Added

- npm publish scripts for staging and latest promotion.

### Fixed

- OpenCode runtime path resolution for key rotation.

## [0.1.0] - 2026-06-15

### Added

- Initial release: automatic key rotation on `session.next.retried` and `session.error`.
- Fingerprint-based credential change detection.
- XDG-based data directory layout.
