import { spawn } from "node:child_process";
import * as os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { agentDisplayName, type AgentConfig, discoverAgents, resolveChildToolNames } from "./agents.ts";
import { agentMutationRefusal, deleteAgentFile, materializeUserOverride, updateAgentFile } from "./agent-writer.ts";
import { colorDot, colorize } from "./colors.ts";
import { openEditor } from "./dashboard-edit.ts";
import { newAgentWizard } from "./wizard.ts";
import { showPreferences } from "./settings.ts";
import type { Keymap } from "./keymap.ts";
import type { RunRegistry } from "./registry.ts";
import type { SubagentState } from "./state.ts";
import type { AgentRunStats } from "./runlog.ts";
import type { LiveSurfaceCoordinator } from "./live-surface.ts";
import type { CallSnapshot, RunNodeSnapshot } from "./registry.ts";
import { TwoPressConfirmation } from "./two-press-confirmation.ts";

const WIDE_BREAKPOINT = 100;

function openInOS(filePath: string): void {
	const platform = os.platform();
	const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
	try {
		spawn(command, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		/* ignore */
	}
}

type DashExit =
	| { kind: "confirm" }
	| { kind: "cancel" }
	| { kind: "editAgent"; agent: AgentConfig }
	| { kind: "newAgent" }
	| { kind: "deleteAgent"; agent: AgentConfig }
	| { kind: "settings" };

export interface DashboardEnv {
	state: SubagentState;
	registry: RunRegistry;
	km: Keymap;
	liveSurface: Pick<LiveSurfaceCoordinator, "setDashboardFocused">;
	/** Read recent history now. The dashboard calls this again after live changes. */
	runStats?: () => Map<string, AgentRunStats>;
}

export function dashboardAgentIdentity(agent: Pick<AgentConfig, "name" | "displayName">): { primary: string; role?: string } {
	const primary = agentDisplayName(agent);
	return { primary, role: primary === agent.name ? undefined : agent.name };
}

export function floorDashboardElapsed(elapsedMs: number): number {
	return Math.floor(Math.max(0, elapsedMs) / 10_000) * 10_000;
}

export interface DashboardElapsedTimer {
	reset(): void;
	dispose(): void;
}

/** Refresh only when the next displayed ten-second elapsed bucket changes. */
export function startDashboardElapsedTimer(
	getSnapshots: (now: number) => readonly CallSnapshot[],
	refresh: () => void,
	now: () => number = Date.now,
	schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
	cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
): DashboardElapsedTimer {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const reset = (): void => {
		if (timer !== undefined) cancel(timer);
		timer = undefined;
		if (disposed) return;
		const current = now();
		const starts: number[] = [];
		const visit = (node: RunNodeSnapshot): void => {
			if (node.status === "active") starts.push(node.startedAt ?? node.plannedAt);
			for (const child of node.children) visit(child);
		};
		for (const call of getSnapshots(current)) for (const root of call.roots) visit(root);
		if (!starts.length) return;
		const delay = Math.min(...starts.map((start) => 10_000 - (Math.max(0, current - start) % 10_000)));
		timer = schedule(() => {
			timer = undefined;
			if (disposed) return;
			refresh();
			reset();
		}, delay);
	};
	reset();
	return {
		reset,
		dispose: () => {
			disposed = true;
			if (timer !== undefined) cancel(timer);
			timer = undefined;
		},
	};
}

export function countActiveExecutions(snapshots: readonly CallSnapshot[]): number {
	let count = 0;
	const visit = (node: RunNodeSnapshot): void => {
		if (node.status === "active") count++;
		for (const child of node.children) visit(child);
	};
	for (const call of snapshots) for (const root of call.roots) visit(root);
	return count;
}

function activeByRole(snapshots: readonly CallSnapshot[]): Map<string, RunNodeSnapshot[]> {
	const result = new Map<string, RunNodeSnapshot[]>();
	const visit = (node: RunNodeSnapshot): void => {
		if (node.status === "active") result.set(node.role, [...(result.get(node.role) ?? []), node]);
		for (const child of node.children) visit(child);
	};
	for (const call of snapshots) for (const root of call.roots) visit(root);
	return result;
}

function accessSummary(agent: AgentConfig): string[] {
	const resolved = resolveChildToolNames(agent, agent.spawn.length > 0);
	const tools = resolved.tools === undefined ? "Pi defaults" : resolved.tools.length > 0 ? resolved.tools.join(", ") : "none";
	return [
		`Model: ${agent.model ?? "session model"}${agent.fallback.length ? ` · fallback ${agent.fallback.join(", ")}` : ""}`,
		`Tools: ${tools}${agent.readonly ? " · read-only" : ""}`,
		`Project conventions: ${agent.conventions ? "yes" : "no"} · structured return: ${agent.returns ? "configured" : "none"}`,
		`Can start: ${agent.spawn.length ? agent.spawn.join(", ") : "no subagents"}`,
	];
}

interface DashResult {
	exit: DashExit;
	auto: Map<string, boolean>;
	selected?: string;
}

async function showDashboard(
	ctx: ExtensionContext,
	env: DashboardEnv,
	agents: AgentConfig[],
	auto0: Map<string, boolean>,
	selected0?: string,
): Promise<DashResult> {
	const { km } = env;
	let focusOwned = true;
	const releaseFocus = (): void => {
		if (!focusOwned) return;
		focusOwned = false;
		env.liveSurface.setDashboardFocused(false);
	};
	env.liveSurface.setDashboardFocused(true);
	try {
		return await ctx.ui.custom<DashResult>((tui: any, theme: any, _kb: any, done: (result: DashResult) => void) => {
			const localAuto = new Map(auto0);
			let index = Math.max(0, agents.findIndex((agent) => agent.name === selected0));
			let narrowView: "list" | "detail" = "list";
			let help = false;
			let cachedWidth: number | undefined;
			let cached: string[] | undefined;
			const confirmation = new TwoPressConfirmation({
				isConfirm: (data) => km.matches("confirm", data),
				isCancel: (data) => km.matches("cancel", data),
			});
			const refresh = (): void => {
				cached = undefined;
				cachedWidth = undefined;
				tui.requestRender();
			};
			const elapsedTimer = startDashboardElapsedTimer(
				(now) => env.registry.activeCallSnapshots(now),
				refresh,
			);
			const off = env.registry.onChange(() => {
				refresh();
				elapsedTimer.reset();
			});
			let cleaned = false;
			const cleanup = (): void => {
				if (cleaned) return;
				cleaned = true;
				off();
				elapsedTimer.dispose();
				releaseFocus();
			};
			const finish = (exit: DashExit): void => {
				cleanup();
				done({ exit, auto: localAuto, selected: agents[index]?.name });
			};

			function handleInput(data: string): void {
				const confirmationResult = confirmation.handle(data);
				if (confirmationResult.kind === "commit") {
					finish({ kind: confirmationResult.action === "confirm" ? "confirm" : "cancel" });
					return;
				}
				if (confirmationResult.kind === "arm") return refresh();
				const agent = agents[index];
				if (data === "?") {
					help = !help;
					refresh();
				} else if (km.matches("left", data)) {
					narrowView = "list";
					refresh();
				} else if (km.matches("right", data)) {
					narrowView = "detail";
					refresh();
				} else if (km.matches("up", data)) {
					index = Math.max(0, index - 1);
					refresh();
				} else if (km.matches("down", data)) {
					index = Math.min(Math.max(0, agents.length - 1), index + 1);
					refresh();
				} else if (km.matches("settings", data)) finish({ kind: "settings" });
				else if (km.matches("new", data)) finish({ kind: "newAgent" });
				else if (km.matches("toggle", data) && agent) {
					const refusal = agentMutationRefusal(agent, "toggle");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else localAuto.set(agent.name, !(localAuto.get(agent.name) ?? agent.auto));
					refresh();
				} else if (km.matches("edit", data) && agent) {
					const refusal = agentMutationRefusal(agent, "edit");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else finish({ kind: "editAgent", agent });
				} else if (km.matches("delete", data) && agent) {
					const refusal = agentMutationRefusal(agent, "delete");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else finish({ kind: "deleteAgent", agent });
				}
				else if (km.matches("open", data) && agent?.filePath) {
					openInOS(agent.filePath);
					ctx.ui.notify(`Opening ${agent.filePath}`, "info");
					refresh();
				}
			}

			function build(width: number): string[] {
				const lines: string[] = [];
				const add = (text = ""): void => { lines.push(truncateToWidth(text, width)); };
				const snapshots = env.registry.activeCallSnapshots(Date.now());
				const active = activeByRole(snapshots);
				const staged = agents.filter((agent) => (localAuto.get(agent.name) ?? agent.auto) !== agent.auto).length;
				const selected = agents[index];
				const borderColor = confirmation.borderColor();
				add(theme.fg(borderColor, "─".repeat(width)));
				if (confirmation.armed === "confirm") add(theme.fg("success", theme.bold(" Apply staged auto-routing changes?")) + theme.fg("dim", ` ${km.label("confirm")} again applies only ${staged} routing change${staged === 1 ? "" : "s"}`));
				else if (confirmation.armed === "cancel") add(theme.fg("error", theme.bold(" Discard staged auto-routing changes?")) + theme.fg("dim", ` ${km.label("cancel")} again discards only routing changes`));
				else add(theme.fg("text", theme.bold(" Agents")) + theme.fg("dim", ` · ${agents.length} roles · ${countActiveExecutions(snapshots)} active executions · ${staged} staged routing changes`));
				add();

				const renderList = (panelWidth: number): string[] => {
					if (!agents.length) return [theme.fg("muted", " No agents found. Create one with " + km.label("new") + ".")];
					return agents.map((agent, row) => {
						const focused = row === index;
						const runs = active.get(agent.name)?.length ?? 0;
						const light = runs ? colorize(agent.color, "●") : theme.fg("dim", "○");
						const identity = dashboardAgentIdentity(agent);
						const name = identity.role ? `${identity.primary} · ${identity.role}` : identity.primary;
						const auto = localAuto.get(agent.name) ?? agent.auto;
						const mode = auto ? theme.fg("success", "AUTO") : theme.fg("dim", "MANUAL");
						const prefix = focused ? theme.fg("accent", "❯") : " ";
						return truncateToWidth(`${prefix} ${light} ${focused ? theme.fg("accent", theme.bold(name)) : name}  ${mode}`, panelWidth);
					});
				};

				const renderDetail = (panelWidth: number): string[] => {
					if (!selected) return [theme.fg("muted", " No role selected.")];
					const out: string[] = [];
					const push = (text = ""): void => out.push(truncateToWidth(text, panelWidth));
					push(`${colorDot(selected.color)} ${theme.bold(dashboardAgentIdentity(selected).primary)}${selected.displayName ? theme.fg("dim", ` · ${selected.name}`) : ""}`);
					push(theme.fg("dim", `Routing · ${(localAuto.get(selected.name) ?? selected.auto) ? "AUTO · model may route" : "MANUAL · slash command or current-turn explicit name"}`));
					for (const wrapped of wrapTextWithAnsi(selected.description, Math.max(1, panelWidth - 2))) push(`  ${wrapped}`);
					push();
					push(theme.fg("text", theme.bold("Live activity")));
					const live = active.get(selected.name) ?? [];
					if (!live.length) push(theme.fg("dim", "  Quiet"));
					for (const node of live) {
						const elapsed = floorDashboardElapsed(Date.now() - (node.startedAt ?? node.plannedAt)) / 1_000;
						const activity = node.activity.tool ? `${node.activity.tool}${node.activity.text ? ` · ${node.activity.text}` : ""}` : node.activity.text ?? node.activity.type;
						push(`  ${colorize(selected.color, "●")} ${elapsed}s · ${activity}`);
					}
					push();
					push(theme.fg("text", theme.bold("Recent stats · 30 days")));
					const stats = env.runStats?.().get(selected.name);
					push(stats ? `  ${stats.runs} runs · ${stats.failed} failed · ${Math.round(stats.avgDurationMs / 1000)}s average${env.state.getShowCosts() ? ` · $${stats.totalCost.toFixed(4)}` : ""}` : theme.fg("dim", "  No recent runs"));
					push();
					push(theme.fg("text", theme.bold("Access")));
					for (const line of accessSummary(selected)) push(`  ${line}`);
					push();
					push(theme.fg("text", theme.bold("Source")));
					push(`  ${selected.source} · ${selected.filePath}`);
					push(theme.fg("dim", `  Command /${selected.name} changes after /reload if you rename this role.`));
					return out;
				};

				if (width >= WIDE_BREAKPOINT) {
					const leftWidth = Math.min(34, Math.max(24, Math.floor(width * 0.32)));
					const rightWidth = width - leftWidth - 3;
					const left = renderList(leftWidth);
					const right = renderDetail(rightWidth);
					for (let row = 0; row < Math.max(left.length, right.length); row++) {
						const leftLine = left[row] ?? "";
						const padding = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)));
						add(`${leftLine}${padding} ${theme.fg("dim", "│")} ${right[row] ?? ""}`);
					}
				} else {
					add(theme.fg("dim", narrowView === "list" ? " List · use right to show detail" : " Detail · use left to show list"));
					for (const line of narrowView === "list" ? renderList(width) : renderDetail(width)) add(line);
				}

				add();
				if (help) {
					const hint = (key: string, label: string): void => add(`   ${theme.fg("accent", truncateToWidth(key, 8).padEnd(8))} ${theme.fg("dim", label)}`);
					add(theme.fg("text", theme.bold("Agent actions")));
					hint(km.label("delete"), "delete");
					hint(km.label("edit"), "edit");
					hint(km.label("open"), "open source");
					hint(km.label("toggle"), "stage auto-routing change");
					add(theme.fg("text", theme.bold("Dashboard actions")));
					hint(`${km.label("confirm")}${km.label("confirm")}`, "apply staged auto-routing changes");
					hint(`${km.label("cancel")}${km.label("cancel")}`, "discard staged auto-routing changes");
					hint(km.label("new"), "new agent");
					hint(km.label("settings"), "settings");
					add(theme.fg("text", theme.bold("Navigation")));
					hint(`${km.label("left")}/${km.label("right")}`, "list or detail");
					hint(`${km.label("up")}/${km.label("down")}`, "select");
				} else {
					const actions = selected
						? `${km.label("delete")} delete  ${km.label("edit")} edit  ${km.label("new")} new  ${km.label("open")} open  ${km.label("toggle")} route  ${km.label("settings")} settings  ? help`
						: `${km.label("new")} new  ${km.label("settings")} settings  ? help`;
					add(theme.fg("dim", ` ${actions}`));
				}
				add(theme.fg(borderColor, "─".repeat(width)));
				return lines;
			}

			return {
				render: (width: number) => {
					if (!cached || cachedWidth !== width) {
						cachedWidth = width;
						cached = build(width);
					}
					return cached;
				},
				invalidate: () => { cached = undefined; cachedWidth = undefined; },
				handleInput,
				dispose: cleanup,
			};
		});
	} finally {
		releaseFocus();
	}
}

export async function openDashboard(ctx: ExtensionContext, env: DashboardEnv): Promise<void> {
	let auto = new Map<string, boolean>();
	let initialized = false;
	let selected: string | undefined;
	while (true) {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: (ctx as any).isProjectTrusted?.() ?? false });
		agents.sort((a, b) => a.name.localeCompare(b.name));
		for (const agent of agents) if (!auto.has(agent.name)) auto.set(agent.name, agent.auto);
		for (const name of [...auto.keys()]) if (!agents.some((agent) => agent.name === name)) auto.delete(name);
		if (!initialized) {
			initialized = true;
			selected = agents[0]?.name;
		}
		const result = await showDashboard(ctx, env, agents, auto, selected);
		auto = result.auto;
		selected = result.selected;
		const exit = result.exit;
		if (exit.kind === "confirm") {
			let changes = 0;
			for (const agent of agents) {
				const next = auto.get(agent.name);
				if (next === undefined || next === agent.auto) continue;
				try {
					if (agent.source === "bundled") materializeUserOverride({ ...agent, auto: next });
					else if (agent.source === "user") updateAgentFile({ ...agent, auto: next });
					else throw new Error("Project agent definitions are read-only");
					changes++;
				} catch {
					ctx.ui.notify(`Could not save ${agent.name}`, "error");
				}
			}
			ctx.ui.notify(changes ? `Applied ${changes} staged auto-routing change${changes === 1 ? "" : "s"}.` : "No staged auto-routing changes.", "info");
			return;
		}
		if (exit.kind === "cancel") return;
		if (exit.kind === "editAgent") {
			const renamed = await openEditor(ctx, exit.agent);
			if (renamed) {
				if (auto.has(renamed.oldName)) auto.set(renamed.newName, auto.get(renamed.oldName)!);
				auto.delete(renamed.oldName);
				selected = renamed.newName;
			}
		} else if (exit.kind === "newAgent") {
			await newAgentWizard(ctx);
		} else if (exit.kind === "settings") {
			await showPreferences(ctx, env.km, env.state);
		} else if (exit.kind === "deleteAgent") {
			const refusal = agentMutationRefusal(exit.agent, "delete");
			if (refusal) {
				ctx.ui.notify(refusal, "warning");
				continue;
			}
			const position = agents.findIndex((agent) => agent.name === exit.agent.name);
			const ok = await ctx.ui.confirm("Delete agent", `Delete ${exit.agent.name}?\nThis also removes ${exit.agent.filePath}`);
			if (ok) {
				deleteAgentFile(exit.agent);
				auto.delete(exit.agent.name);
				selected = agents[position + 1]?.name ?? agents[position - 1]?.name;
				ctx.ui.notify(`Deleted ${exit.agent.name}.`, "info");
			}
		}
	}
}
