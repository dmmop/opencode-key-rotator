# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Prettier configuration and formatting checks.
- GitHub Actions CI workflow with typecheck, build, tests, format check, and runtime smoke tests.
- GitHub Actions npm publish workflow with provenance attestations.
- Comprehensive test suite: server integration tests, sanitization tests, CLI tests, and config loader tests.
- Sidecar configuration file at `~/.config/opencode/opencode-key-rotator/config.json`.
- Expanded README with badges, configuration reference, troubleshooting, and development guide.
- GitHub issue templates for bug reports and feature requests.

### Changed

- `createKeyStore` accepts an optional `KeyRotatorConfig` for configurable lock TTL.
- `server` and `tui` plugins load configuration and use configurable rotation patterns, dedup TTL, and toast duration.

### Fixed

- `opencode-key-rotator remove` no longer creates empty config files when they do not exist.
- `--help` now exits with code 0.

## [0.1.1] - 2026-06-15

### Added

- npm publish scripts for staging and latest promotion.

### Fixed

- OpenCode runtime path resolution for key rotation.

## [0.1.0] - 2026-06-15

### Added

- Initial release: automatic key rotation on `session.next.retried` and `session.error`.
- TUI commands `/key-save`, `/key-switch`, and `/key-status`.
- Fingerprint-based credential change detection.
- XDG-based data directory layout.
