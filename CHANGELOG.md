# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial public beta of Pi Subagent Supervisor.
- Isolated subagent execution, configurable agent definitions, nested runs, fallbacks, structured returns, and routing controls.
- Dashboard, unified staged Create/Edit agent workbench, run history, cost reporting, and bundled agent roles.
- Readable and exact structured-result views, including dedicated Findings, Review, and Decision presentations and a per-agent override.

### Changed

- Existing agents now use the lossless AgentDraft workbench with bounded model, thinking, permission, delegation, and output controls; unavailable saved choices remain preserved.
- Structured-result descriptors are versioned validation recipes; canonical child text remains authoritative and parsed values are never persisted.
- Documentation now distinguishes transcript task/result visibility, parent-model return shapes, slash-command output, structured views, and telemetry-only run history.

[Unreleased]: https://github.com/drawde-nadroj/pi-subagent-supervisor/commits/main
