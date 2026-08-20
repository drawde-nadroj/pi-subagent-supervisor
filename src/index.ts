import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, isKeyRelease, Markdown, matchesKey, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { appendDebuggerNudge, isTestOrBuildCommand } from "./backstops.ts";
import { agentDisplayName, discoverAgents } from "./agents.ts";
import { openDashboard } from "./dashboard.ts";
import { emptyUsage, type RunResult } from "./engine.ts";
import { buildActiveAgentsBlock } from "./guidance.ts";
import { executeHistoryCommand, parseHistoryCommand } from "./history.ts";
import { Keymap } from "./keymap.ts";
import { bridgeHerdrWorkingLease, LiveSurfaceCoordinator } from "./live-surface.ts";
import { presentMessageIdentity, terminalOutputSummary, type StoredMessageIdentity } from "./message-presentation.ts";
import { RunRegistry, type CallSnapshot } from "./registry.ts";
import { SubagentState } from "./state.ts";
import { type DispatchDeps, dispatchSingle, fmtDuration, registerSubagentTool } from "./tool.ts";
import { aggregateRunStats, appendRunLogIfEnabled, entryFromRecord, filterRecentEntries, formatRunStats, getDefaultRunLogPath, readRunLog } from "./runlog.ts";
import { migrateLegacyStorage } from "./storage.ts";

interface OutputDetails extends StoredMessageIdentity {
	ok: boolean;
	elapsedMs?: number;
	task?: string;
	text: string;
	usage: { input: number; output: number; cost: number; tools?: number };
}

class CompactTaskLine implements Component {
	private readonly text: string;
	private readonly dim: (text: string) => string;

	constructor(text: string, dim: (text: string) => string) {
		this.text = text;
		this.dim = dim;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.dim(`  ${this.text.replace(/\s+/g, " ").trim()}`), Math.max(1, width))];
	}
	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	migrateLegacyStorage();
	const registry = new RunRegistry();
	const state = new SubagentState();
	const km = new Keymap(state);
	const holder: { ctx?: ExtensionContext } = {};
	const liveSurface = new LiveSurfaceCoordinator({
		registry,
		getUi: () => holder.ctx?.ui,
		showCosts: () => state.getShowCosts(),
		onActiveChange: (change) => bridgeHerdrWorkingLease(pi.events, change),
	});
	const stopActivityBridge = registry.publishActivityTo(pi.events);
	const registered = new Set<string>();
	const runLogPath = getDefaultRunLogPath();

	// Check the persisted preference at completion time so changing it while a run
	// is active takes effect before that run can be appended.
	registry.onFinish((rec) => appendRunLogIfEnabled(runLogPath, () => state.getHistoryEnabled(), entryFromRecord(rec)));

	const hasAgent = (ctx: ExtensionContext, name: string): boolean => {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		return agents.some((a) => a.name === name);
	};

	// Render a dispatched run's result into the transcript (for /<name> and sequences).
	pi.registerMessageRenderer<OutputDetails>("subagent-output", (msg, _opts, theme) => {
		const d = msg.details;
		if (!d) return undefined;
		const identity = presentMessageIdentity(d);
		const c = new Container();
		const icon = d.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const elapsed = d.elapsedMs != null ? `${fmtDuration(d.elapsedMs)} · ` : "";
		const tools = d.usage.tools != null ? `${d.usage.tools}⚒ · ` : "";
		const cost = state.getShowCosts() ? ` $${d.usage.cost.toFixed(4)}` : "";
		c.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(identity.persona))}${identity.role ? theme.fg("dim", ` · ${identity.role}`) : ""} ${theme.fg("dim", `${elapsed}${tools}↑${d.usage.input} ↓${d.usage.output}${cost}`)}`,
				0,
				0,
			),
		);
		if (d.task) c.addChild(new CompactTaskLine(d.task, (text) => theme.fg("dim", text)));
		// Agents answer in markdown — render it instead of dumping raw text.
		c.addChild(new Markdown(d.text || "(no output)", 0, 0, getMarkdownTheme()));
		return c;
	});

	const showOutput = (
		agent: string,
		r: RunResult,
		options?: { snapshot?: CallSnapshot },
	): void => {
		const summary = terminalOutputSummary(r, options?.snapshot);
		// A single /name call has one authoritative terminal identity. Sequences
		// return their final step but retain their synthesized sequence label.
		const terminalRoot = options?.snapshot?.mode === "single"
			? options.snapshot.roots[0]
			: options?.snapshot?.roots.filter((root) => root.status !== "dormant").at(-1);
		pi.sendMessage<OutputDetails>({
			customType: "subagent-output",
			content: summary.text || "(no output)",
			display: true,
			details: {
				agent,
				role: terminalRoot?.role,
				persona: terminalRoot?.persona,
				ok: summary.ok,
				elapsedMs: summary.elapsedMs,
				task: terminalRoot?.task,
				text: summary.text || "(no output)",
				usage: summary.usage,
			},
		});
	};

	// /agents stats — the per-agent cost table, monospace-aligned in the transcript.
	pi.registerMessageRenderer<{ lines: string[] }>("subagent-stats", (msg, _opts, theme) => {
		const d = msg.details;
		if (!d) return undefined;
		const c = new Container();
		c.addChild(new Text(theme.fg("toolTitle", theme.bold("subagent stats")), 0, 0));
		d.lines.forEach((line, i) => {
			const isEdge = i === 0 || i === d.lines.length - 1;
			c.addChild(new Text(isEdge ? theme.fg("muted", line) : line, 0, 0));
		});
		return c;
	});

	// Default to a recent window — the actionable tuning signal is "is this agent
	// paying off *lately*", not a lifetime average that never forgets an old bad run.
	// `/agents stats all` shows the full history.
	const STATS_WINDOW_DAYS = 30;
	const showStats = (all: boolean): void => {
		const entries = readRunLog(runLogPath);
		const scoped = all ? entries : filterRecentEntries(entries, STATS_WINDOW_DAYS);
		showCommandLines(formatRunStats(aggregateRunStats(scoped), all ? "all sessions" : `last ${STATS_WINDOW_DAYS} days`));
	};

	const showRoster = (ctx: ExtensionContext): void => {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		const lines = agents.length
			? ["Available subagents:", ...agents.map((a) => `- /${a.name} <task> — ${a.description}`), "", "Other commands: /agents stats, /agents history on|off|status|clear, /agents returns [on|off], /agents -k"]
			: ["No subagents discovered."];
		showCommandLines(lines);
	};

	let currentUserPrompt: string | undefined;
	const deps: DispatchDeps = {
		registry,
		currentUserPrompt: () => currentUserPrompt,
		getCtx: () => holder.ctx as ExtensionContext,
		showOutput: (agent, result, snapshot) => showOutput(agent, result, { snapshot }),
		structuredReturns: () => state.getStructuredReturns(),
		showCosts: () => state.getShowCosts(),
		liveSurface,
	};

	const showCommandLines = (lines: string[]): void => {
		pi.sendMessage<{ lines: string[] }>({
			customType: "subagent-stats",
			content: lines.join("\n"),
			display: true,
			details: { lines },
		});
	};

	registerSubagentTool(pi, deps);


	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || !event.isError) return;
		const command = String(event.input.command ?? "");
		if (!isTestOrBuildCommand(command)) return;
		if (!hasAgent(ctx, "debugger")) return;
		return { content: appendDebuggerNudge(event.content, command) };
	});

	const killAll = (ctx: ExtensionContext): void => {
		let n = 0;
		for (const r of registry.running()) {
			registry.stop(r);
			n++;
		}
		const message = n ? `Killed ${n} subagent${n > 1 ? "s" : ""}.` : "No running subagents.";
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		else showCommandLines([message]);
	};

	// Auto-spawn: only `auto: true` descriptions enter proactive routing.
	// Hidden agents remain reachable through /name, sequences, or an explicit user-named request.
	pi.on("before_agent_start", (event, ctx) => {
		holder.ctx = ctx;
		currentUserPrompt = typeof event.prompt === "string" ? event.prompt : undefined;
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		const block = buildActiveAgentsBlock(agents);
		return block ? { systemPrompt: `${event.systemPrompt}\n${block}` } : {};
	});

	pi.registerCommand("agents", {
		description: "Open the subagents dashboard. `/agents -k` kills running subagents; `/agents stats` shows recent cost history; `/agents history on|off|status|clear` controls local history; `/agents returns [on|off]` toggles structured returns.",
		handler: async (args, ctx) => {
			holder.ctx = ctx;
			const a = args.trim();
			if (a === "-k") {
				killAll(ctx);
				return;
			}
			if (a === "stats" || a === "stats all" || a === "stats recent") {
				showStats(a === "stats all");
				return;
			}
			const historyAction = parseHistoryCommand(a);
			if (historyAction !== undefined) {
				const result = executeHistoryCommand(historyAction, state, runLogPath);
				if (ctx.hasUI) ctx.ui.notify(result.message, result.level);
				else showCommandLines([result.message]);
				return;
			}
			// `/agents returns [on|off]` — toggle `returns:` schema enforcement.
			if (a.startsWith("returns")) {
				const rest = a.slice(7).trim().toLowerCase();
				const next = rest === "on" ? true : rest === "off" ? false : !state.getStructuredReturns();
				state.setStructuredReturns(next);
				const message = `Structured returns ${next ? "ON — agents with a returns: schema must end with matching JSON (one repair turn)" : "OFF — returns: schemas are ignored"}.`;
				if (ctx.hasUI) ctx.ui.notify(message, "info");
				else showCommandLines([message]);
				return;
			}
			if (ctx.mode !== "tui") {
				showRoster(ctx);
				return;
			}
			await openDashboard(ctx, {
				state, registry, km, liveSurface,
				// Roster cost column mirrors the default `/agents stats` window (recent, not lifetime).
				runStats: () => new Map(aggregateRunStats(filterRecentEntries(readRunLog(runLogPath), STATS_WINDOW_DAYS)).map((s) => [s.agent, s])),
			});
			// Pick up any agent created or renamed via the workbench so its /<name> command exists immediately.
			registerAgentCommands(ctx);
		},
	});

	pi.registerCommand("stop-agents", {
		description: "Kill all running subagents (same as /agents -k)",
		handler: async (_args, ctx) => {
			holder.ctx = ctx;
			killAll(ctx);
		},
	});

	function registerAgentCommands(ctx: ExtensionContext) {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		for (const a of agents) {
			if (registered.has(a.name)) continue;
			registered.add(a.name);
			try {
				pi.registerCommand(a.name, {
					description: `Delegate to ${a.name}: ${a.description.slice(0, 60)}`,
					handler: async (args, c) => {
						holder.ctx = c;
						const current = discoverAgents(c.cwd, { includeProject: c.isProjectTrusted?.() ?? false }).agents.find((agent) => agent.name === a.name);
						if (!current) {
							showOutput(a.name, { ok: false, finalText: "", error: `Agent '${a.name}' no longer exists. Run /agents to refresh the roster.`, usage: emptyUsage(), contextPercent: null });
							return;
						}
						const trimmed = args.trim();
						const task = trimmed || (c.hasUI ? (await c.ui.input(`Task for ${agentDisplayName(current)}`, "Describe the task…")) || "" : "");
						if (!task) {
							showOutput(current.name, { ok: false, finalText: "", error: `No task provided. Use /${current.name} <task>.`, usage: emptyUsage(), contextPercent: null });
							return;
						}
						let terminalSnapshot: CallSnapshot | undefined;
						const result = await dispatchSingle(deps, current, task, undefined, {
							launchSurface: "foreground",
							onComplete: (snapshot) => {
								terminalSnapshot = snapshot;
							},
						});
						showOutput(current.name, result, { snapshot: terminalSnapshot });
					},
				});
			} catch {
				/* duplicate across reloads */
			}
		}
	}

	// Show cumulative subagent cost as a footer segment next to pi's own $ figure.
	// (pi's built-in $ tracks only the main session; there's no API to add into it,
	// so we surface subagent spend as its own status-bar segment.)
	let costStatusWired = false;
	const updateCostStatus = () => {
		const ui = holder.ctx?.ui;
		if (!ui?.setStatus) return;
		const total = registry.totalCost();
		ui.setStatus("subagent-cost", state.getShowCosts() && total > 0 ? `⊕ $${total.toFixed(4)} subagents` : undefined);
	};

	pi.on("session_start", (_e, ctx) => {
		holder.ctx = ctx;
		registerAgentCommands(ctx);
		if (!ctx.hasUI) return;
		// Raw terminal listeners run before focused components and built-in
		// keybindings; registered shortcuts only reach Pi's default editor.
		ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data) || !matchesKey(data, "ctrl+shift+o")) return;
			ctx.ui.setToolsExpanded(true);
			return { consume: true };
		});
		// The footer carries bounded live progress plus a cumulative cost segment.
		// Cost is refreshed on every run change.
		if (!costStatusWired) {
			costStatusWired = true;
			registry.onChange(updateCostStatus);
			state.onChange(updateCostStatus);
		}
		updateCostStatus();
		liveSurface.refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopActivityBridge();
		liveSurface.dispose();
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagent-cost", undefined);
		}
	});
}
