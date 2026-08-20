# Pi Subagent Supervisor

A transparent supervisor for isolated Pi subagents. Configure how each role works, delegate single, parallel, or sequence tasks, and inspect the assigned work and returned results in Pi's transcript.

## Capabilities

- isolated child sessions with separate prompts and in-memory session state
- model-facing `subagent` tool and per-role slash commands
- up to 10 parallel tasks with one immediate respawn per failed branch, plus ordered sequences with configured execution-failure retries
- dashboard and staged workbench for routing, creating, inspecting, editing, opening, and deleting custom roles
- model selection, provider-error fallback models, thinking level, tool limits, read-only mode, project conventions, structured returns, and nested delegation
- visible assigned tasks and terminal results for model-tool roots and their nested subagents
- live run status, token/cost reporting, stop controls, and local aggregate statistics

## Bundled roles

The package works without copying agent files. It bundles `scout`, `planner`, `worker`, `test-writer`, `reviewer`, `debugger`, and `oracle`. These durable role names are also their slash-command names. All seven opt into automatic routing. `scout`, `planner`, `reviewer`, and `oracle` are read-only. `worker`, `test-writer`, and `debugger` can change files and run shell commands, with only `read`, `bash`, `edit`, and `write`. Their descriptions define when Pi should route work to them.

## Install

Requires Node.js 22.19 or newer. Tested with Pi 0.84.2.

From npm:

```sh
pi install npm:pi-subagent-supervisor
```

From a local checkout:

```sh
pi install /absolute/path/to/pi-subagent-supervisor
```

From GitHub ([repository](https://github.com/drawde-nadroj/pi-subagent-supervisor)):

```sh
pi install git:github.com/drawde-nadroj/pi-subagent-supervisor
```

For one session without installing, use `pi -e /absolute/path/to/pi-subagent-supervisor`.

## Use

- `/agents` opens the dashboard.
- `/agents -k` stops all active subagents.
- `/agents stats` shows the last 30 days; `/agents stats all` shows all local history.
- `/agents history on|off|status|clear` controls local run-history recording. Recording defaults to on; turning it off retains existing history, and `clear` deletes it without changing the preference.
- `/agents returns on|off` controls structured-return enforcement.
- `/stop-agents` stops active runs.
- `/<role> <task>` runs one discovered role.

Automatic and explicit subagent runs call the configured model and can add provider usage, cost, and latency. Parallel work can reduce elapsed time but multiply usage; retries and dependent or nested delegation can extend completion time. Use `/agents stats` to inspect recorded totals.

The model-facing tool accepts exactly one mode:

- single: `{ agent, task }`
- parallel: `{ tasks: [{ agent, task }] }`
- sequence: `{ chain: [{ agent, task }] }`; `{previous}` inserts the prior result

A sequence may define `retry` with `maxRetries` and `retrySteps`. Retries happen only after execution failure; they do not interpret review verdicts.

## What you can inspect

The extension keeps orchestration visible without adding full transcripts to run history:

- **While a model-tool call runs:** its row shows every root and nested subagent, the assigned task, current state or concrete tool activity, and elapsed time. A parent waiting for its delegated child is shown as waiting while independent parallel branches can continue.
- **After a model-tool call finishes:** the collapsed row keeps every root and nested task plus its terminal answer or error. Pi's configured tool-output expansion shortcut adds activity and execution metrics. For validated structured results, it also shows both Readable and Exact JSON views.
- **What the parent model receives:** a single call returns that root's final text; a parallel call returns every root result with labels and success state; a successful sequence returns only its final step. `{previous}` passes the preceding step's final text without a second model rewriting it.
- **Per-role slash commands:** `/<role>` renders the requested root task and terminal answer as a transcript message. Its usage totals include nested work, but the final slash-command message does not reproduce the complete nested tree.

Each stored or returned agent result is capped at 50 KiB. Optional **Effective prompt capture** (Preferences, off by default) records the exact effective system prompt and first user message immediately before each child session launch. The system prompt may include inherited `AGENTS.md` text and Pi's tool and working-directory composition. The first user message contains the launch input: the assigned task plus any structured-return instruction appended by the supervisor. Expanded terminal run views identify each attempt and show its runtime provider/model, thinking level, active tools, and working directory. Repair prompts are never captured.

Captured prompts are sensitive parent Pi session details. They are included in session exports and backups, and deletion follows deletion of the parent session. Disabling capture prevents future capture; runs launched while disabled are not retroactively available. Fixed per-field, per-attempt, per-call, and attempt-count limits produce explicit omission records. This is not a full conversation transcript and cannot expose provider-hidden instructions. “Assigned task” elsewhere in the UI is distinct from the exact launch input shown here.

`runs.jsonl` is separate from transcript presentation. It stores one telemetry record per root run, including timestamps, role and status, working directory, token and tool usage, cost, the first 80 characters of normalized task text, and up to 120 characters of failure text. It does not store answers, effective prompts, launch prompts, transcripts, or parsed structured-result values.

## Discovery and trust

Names are merged in this order, with later layers winning:

1. bundled `agents/*.md`
2. user `~/.pi/agent/agents/*.md`
3. nearest trusted `.claude/agents/*.md`
4. nearest trusted native `.pi/agents/*.md`

Project definitions are ignored unless Pi marks the project trusted. Claude tool names are translated to Pi names.

## Agent files

Each file is Markdown with YAML frontmatter and a body used as the child system prompt. Supported fields:

- `name` (required): durable role, command, and persistence identity
- `description` (required): routing contract shown to the parent
- `displayName`: optional presentation name
- `auto`: allow automatic model-tool routing and advertise proactively; defaults to `true`. `auto: false` remains available through `/<name>`, or through a root model-tool call only when the current user turn explicitly names the agent (a durable name boundary or `/name`).
- `model`: provider/model pattern; otherwise inherit the parent model
- `fallback`: ordered model patterns used only for provider-shaped failures
- `thinking`: child reasoning level
- `tools`: tool allowlist
- `readonly`: restrict to read tools (and explicitly allowed `git-inspect`)
- `color`: presentation color
- `conventions`: inherit global and path-scoped `AGENTS.md` conventions
- `spawn`: roles this child may delegate to
- `returns`: supported JSON-schema subset for the final response
- `resultView`: optional `readable` or `exact` TUI presentation override for valid structured returns

Compatibility aliases remain supported: `fallbackModels` for `fallback`, `fork` for `conventions`, and `advertise` (`always`/`judgment`/`never`) for `auto`. Claude agent tool names are also accepted in the Claude discovery layer.

## Customization

To disable automatic routing for a role, open `/agents`, select the role, press the configured Toggle key (`space` by default) to stage the change, then press the configured Confirm key twice (`Enter` by default) to apply it. Dashboard changes to `auto` are staged, not applied immediately: confirm the staged changes to write them, or cancel to leave disk unchanged. Package-managed bundled files are never changed: editing a bundled role or confirming its staged `auto` value creates a same-name user override under `~/.pi/agent/agents`. A bundled identity cannot be renamed in place; create a new role instead. Bundled roles cannot be deleted. Deleting a user override can reveal the bundled default beneath it.

New and existing user definitions use the same staged workbench: Identity, Routing, Capabilities, Instructions, Output, and Review. Existing values remain selected even when their model, thinking level, fallback, or spawn target is not currently available. Saving an edited bundled role creates a same-name user override; bundled identities cannot be renamed. User renames use collision-safe persistence. Trusted project definitions are visible in the dashboard but Edit is refused; change those source files externally.

## Execution details

Children do not receive the parent transcript, extensions, skills, or the normal context-file stack. `conventions: true` adds only global and path-scoped `AGENTS.md` files. Models inherit by default; fallback models run only after quota, authentication, network, availability, or similar provider errors—not ordinary task failure.

A `returns` schema adds validation and one repair turn when enabled. Structured results default to **Readable** presentation. Each agent may inherit the global preference or override it with **Readable** or **Exact JSON**. Exact JSON is `JSON.stringify` of the validated extracted value; metadata or extraction failures fall back to raw final text. Pi's configured tool-output expansion shortcut (`Ctrl+O` by default) shows both views; expansion is global, not a focusable per-row control. Presentation changes only the TUI: canonical parent-facing tool content, substitutions, nested returns, result/error semantics, and `RunResult.finalText` remain unchanged.

Nested delegation is depth-limited; nested parallel calls require every target to be read-only. Parallel and nested work can increase usage quickly.

## Local data and privacy

Preferences and history live outside the installed package under `~/.pi/agent/pi-subagents/` (or the configured Pi agent directory). `state.json` stores preferences. `runs.jsonl` is run-history telemetry only: truncated task and failure summaries, working directories, token/tool usage, and cost. It does not store answers, effective prompts, launch prompts, transcripts, or parsed structured-result values. Cost values are provider-reported estimates, not billing records. On first startup after upgrading from package-local storage, either legacy file is copied here if no destination file exists. Parent directories are created as needed and files use private permissions where supported. Package updates and uninstalling the extension do not wipe these files. Nothing in this extension uploads the history, but model providers still receive tasks executed with their models.

Prompt capture is stored only in the parent Pi session, not in `state.json` or `runs.jsonl`; `state.json` stores only the `promptCaptureEnabled` preference.

Use `/agents history off` to stop new history while retaining existing entries, or `/agents history clear` to delete only `runs.jsonl`. To remove all extension data after uninstalling, delete the `pi-subagents` data directory manually.

## Limitations

Dashboard keys are remappable. The shared Create/Edit workbench writes only after two Review confirmations; cancel discards its full draft. Editor and picker sub-overlays still use their fixed default navigation keys.

## Development

```sh
npm test
pi -p -e ./src/index.ts --no-extensions --no-session "List the available subagents."
npm pack --dry-run
```

`npm run test:routing:fast` and `npm run test:routing` invoke real agents and may incur provider charges. They are not part of the normal unit-test command.

## Release checklist

1. Run `npm test` and a headless load/discovery smoke test.
2. Run `npm pack --dry-run`; verify only `src/`, bundled agents, and public documents are included.
3. Review package metadata and version, then inspect the final diff.
4. Run paid routing evaluation only when explicitly intended.

## Security

Agent definitions and project conventions are executable instructions to models with the configured tools. Trust project files before enabling project discovery, review writable tool access, and inspect third-party role prompts before use. Isolation reduces accidental context sharing; it is not a security sandbox.
