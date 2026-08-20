import { spawn } from "node:child_process";
import * as os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { agentDisplayName, type AgentConfig, discoverAgents, resolveChildToolNames } from "./agents.ts";
import { agentMutationRefusal, deleteAgentFile, materializeUserOverride, updateAgentFile } from "./agent-writer.ts";
import { colorDot, colorize } from "./colors.ts";
import { classifyResultPreset } from "./result-view.ts";
import { appendOutputFieldName, backspaceOutputFieldName, beginOutputFieldNaming, cancelOutputFieldNaming, commitOutputFieldNaming, createOutputEditor, cycleOutputEditor, deleteOutputField, editOutputEditor, effectiveOutputView, moveOutputEditor, outputFrontmatterPreview, outputSamplePreview, persistOutputEditor, reorderOutputField, replaceCustomWithGuided, reviewOutputEditor, toggleOutputFieldRequired, type OutputEditorState } from "./output-editor.ts";
import { editAgentWorkbench, newAgentWorkbench, type WorkbenchEditResult } from "./workbench.ts";
import { showPreferences } from "./settings.ts";
import type { Keymap } from "./keymap.ts";
import type { RunRegistry } from "./registry.ts";
import type { SubagentState } from "./state.ts";
import type { AgentRunStats, RunLogEntry } from "./runlog.ts";
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
	| { kind: "saveOutput"; agent: AgentConfig; draft: OutputEditorState["draft"] }
	| { kind: "newAgent" }
	| { kind: "deleteAgent"; agent: AgentConfig }
	| { kind: "settings" };

export interface DashboardEnv {
	state: SubagentState;
	registry: RunRegistry;
	km: Keymap;
	liveSurface: Pick<LiveSurfaceCoordinator, "setDashboardFocused">;
	/** Read recent history now. The Studio calls these again after live changes. */
	runStats?: () => Map<string, AgentRunStats>;
	latestRuns?: () => Map<string, RunLogEntry>;
	/** Focused-screen seams keep the Studio loop testable without changing production behavior. */
	discover?: () => AgentConfig[];
	editWorkbench?: (ctx: ExtensionContext, km: Keymap, agent: AgentConfig, effectiveAuto?: boolean) => Promise<WorkbenchEditResult | undefined>;
	newWorkbench?: (ctx: ExtensionContext, km: Keymap) => Promise<void>;
	persistOutput?: typeof persistOutputEditor;
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

function outputContractSummary(schema: NonNullable<AgentConfig["returns"]>): string[] {
	const type = schema.type ?? (schema.enum ? "enum" : "unspecified");
	const lines = [`Type: ${type}`];
	if (schema.type === "object") {
		const fields = Object.keys(schema.properties ?? {});
		lines.push(`Fields: ${fields.length ? fields.join(", ") : "none"}`);
		lines.push(`Required: ${schema.required?.length ? schema.required.join(", ") : "none"}`);
	} else if (schema.type === "array") lines.push(`Items: ${schema.items?.type ?? (schema.items?.enum ? "enum" : "unspecified")}`);
	if (schema.enum) lines.push(`Values: ${schema.enum.join(", ")}`);
	return lines;
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
		return await ctx.ui.custom<DashResult>((tui: any, theme: any, kb: any, done: (result: DashResult) => void) => {
			const localAuto = new Map(auto0);
			let index = Math.max(0, agents.findIndex((agent) => agent.name === selected0));
			const narrowViews = ["roles", "configure", "output"] as const;
			let narrowView: typeof narrowViews[number] = "roles";
			let help = false;
			let outputEditor: OutputEditorState | undefined;
			let outputEditorPreviousView: typeof narrowViews[number] = "roles";
			let cachedWidth: number | undefined;
			let cached: string[] | undefined;
			const confirmation = new TwoPressConfirmation({
				isConfirm: (data) => km.matches("confirm", data, kb),
				isCancel: (data) => km.matches("cancel", data, kb),
			});
			const outputSaveConfirmation = new TwoPressConfirmation({
				isConfirm: (data) => km.matches("confirm", data, kb),
				isCancel: () => false,
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
				const agent = agents[index];
				if (outputEditor) {
					if (outputEditor.naming) {
						if (km.matches("cancel", data, kb)) cancelOutputFieldNaming(outputEditor);
						else if (km.matches("confirm", data, kb)) commitOutputFieldNaming(outputEditor);
						else if (data === "\x7f" || data === "\b") backspaceOutputFieldName(outputEditor);
						else appendOutputFieldName(outputEditor, data);
						refresh();
						return;
					}
					if (km.matches("cancel", data, kb)) {
						outputEditor = undefined;
						narrowView = outputEditorPreviousView;
						outputSaveConfirmation.reset();
						refresh();
						return;
					}
					if (outputEditor.stage === "review") {
						if (km.matches("back", data, kb)) {
							editOutputEditor(outputEditor);
							outputSaveConfirmation.reset();
							refresh();
							return;
						}
						const result = outputSaveConfirmation.handle(data);
						if (result.kind === "commit" && agent) return finish({ kind: "saveOutput", agent, draft: outputEditor.draft });
						if (result.kind !== "pass") {
							if (result.kind === "arm" || result.kind === "disarm") refresh();
							return;
						}
						if (km.matches("preview", data, kb)) {
							narrowView = narrowView === "output" ? "configure" : "output";
							refresh();
						}
						return;
					}
					// Confirm remains authoritative when a configured key collides with an edit action.
					if (km.matches("confirm", data, kb)) reviewOutputEditor(outputEditor);
					else if (km.matches("up", data, kb)) moveOutputEditor(outputEditor, -1);
					else if (km.matches("down", data, kb)) moveOutputEditor(outputEditor, 1);
					else if (km.matches("left", data, kb)) cycleOutputEditor(outputEditor, -1);
					else if (km.matches("right", data, kb)) cycleOutputEditor(outputEditor, 1);
					else if (km.matches("new", data, kb)) {
						if (outputEditor.choice === "Custom" && outputEditor.customMode === "preserve-only") replaceCustomWithGuided(outputEditor);
						else beginOutputFieldNaming(outputEditor, "add");
					}
					else if (km.matches("edit", data, kb)) beginOutputFieldNaming(outputEditor, "rename");
					else if (km.matches("delete", data, kb)) deleteOutputField(outputEditor);
					else if (km.matches("toggle", data, kb)) toggleOutputFieldRequired(outputEditor);
					else if (km.matches("reorderUp", data, kb)) reorderOutputField(outputEditor, -1);
					else if (km.matches("reorderDown", data, kb)) reorderOutputField(outputEditor, 1);
					else if (km.matches("preview", data, kb)) {
						narrowView = narrowView === "output" ? "configure" : "output";
					} else return;
					refresh();
					return;
				}

				const hasStagedRouting = agents.some((item) => (localAuto.get(item.name) ?? item.auto) !== item.auto);
				// Contract wins a collision with the otherwise meaningless global Confirm
				// action. Once routing is staged, Confirm keeps priority until it is applied.
				if (!hasStagedRouting && km.matches("contract", data, kb) && agent) {
					const refusal = agentMutationRefusal(agent, "edit");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else {
						outputEditor = createOutputEditor(agent, env.state.getResultView());
						outputEditorPreviousView = narrowView;
						narrowView = "configure";
						help = false;
					}
					refresh();
					return;
				}

				const confirmationResult = confirmation.handle(data);
				if (confirmationResult.kind === "commit") {
					finish({ kind: confirmationResult.action === "confirm" ? "confirm" : "cancel" });
					return;
				}
				if (confirmationResult.kind === "arm") return refresh();
				if (km.matches("help", data, kb)) {
					help = !help;
					refresh();
				} else if (km.matches("left", data, kb)) {
					const view = narrowViews.indexOf(narrowView);
					narrowView = narrowViews[(view + narrowViews.length - 1) % narrowViews.length];
					refresh();
				} else if (km.matches("right", data, kb)) {
					const view = narrowViews.indexOf(narrowView);
					narrowView = narrowViews[(view + 1) % narrowViews.length];
					refresh();
				} else if (km.matches("up", data, kb)) {
					index = Math.max(0, index - 1);
					refresh();
				} else if (km.matches("down", data, kb)) {
					index = Math.min(Math.max(0, agents.length - 1), index + 1);
					refresh();
				} else if (km.matches("settings", data, kb)) finish({ kind: "settings" });
				else if (km.matches("new", data, kb)) finish({ kind: "newAgent" });
				else if (km.matches("contract", data, kb) && agent) {
					const refusal = agentMutationRefusal(agent, "edit");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else {
						outputEditor = createOutputEditor(agent, env.state.getResultView());
						outputEditorPreviousView = narrowView;
						narrowView = "configure";
						help = false;
					}
					refresh();
				} else if (km.matches("toggle", data, kb) && agent) {
					const refusal = agentMutationRefusal(agent, "toggle");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else localAuto.set(agent.name, !(localAuto.get(agent.name) ?? agent.auto));
					refresh();
				} else if (km.matches("edit", data, kb) && agent) {
					const refusal = agentMutationRefusal(agent, "edit");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else finish({ kind: "editAgent", agent });
				} else if (km.matches("delete", data, kb) && agent) {
					const refusal = agentMutationRefusal(agent, "delete");
					if (refusal) ctx.ui.notify(refusal, "warning");
					else finish({ kind: "deleteAgent", agent });
				}
				else if (km.matches("open", data, kb) && agent?.filePath) {
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
				const borderColor = outputEditor ? outputSaveConfirmation.borderColor() : confirmation.borderColor();
				add(theme.fg(borderColor, "─".repeat(width)));
				if (outputSaveConfirmation.armed === "confirm") add(theme.fg("success", theme.bold(" Save Output Contract?")) + theme.fg("dim", ` ${km.label("confirm", kb)} again writes ${selected?.name ?? "the role"}`));
				else if (confirmation.armed === "confirm") add(theme.fg("success", theme.bold(" Apply staged auto-routing changes?")) + theme.fg("dim", ` ${km.label("confirm", kb)} again applies only ${staged} routing change${staged === 1 ? "" : "s"}`));
				else if (confirmation.armed === "cancel") add(theme.fg("error", theme.bold(" Discard staged auto-routing changes?")) + theme.fg("dim", ` ${km.label("cancel", kb)} again discards only routing changes`));
				else add(theme.fg("text", theme.bold(" Subagent Studio")) + theme.fg("dim", ` · ${agents.length} roles · ${countActiveExecutions(snapshots)} active executions · ${staged} staged routing changes${outputEditor ? " · Output Contract draft" : ""}`));
				add();

				const renderRoster = (panelWidth: number): string[] => {
					const out = [theme.fg("text", theme.bold("Roles / live state"))];
					if (!agents.length) return [...out, theme.fg("muted", " No roles found. Create one with " + km.label("new", kb) + ".")];
					for (const [row, agent] of agents.entries()) {
						const focused = row === index;
						const runs = active.get(agent.name)?.length ?? 0;
						const light = runs ? colorize(agent.color, "●") : theme.fg("dim", "○");
						const identity = dashboardAgentIdentity(agent);
						const name = identity.role ? `${identity.primary} · ${identity.role}` : identity.primary;
						const auto = localAuto.get(agent.name) ?? agent.auto;
						const mode = auto ? theme.fg("success", "AUTO") : theme.fg("dim", "MANUAL");
						const live = runs ? theme.fg("warning", ` · ${runs} live`) : "";
						const prefix = focused ? theme.fg("accent", "❯") : " ";
						out.push(truncateToWidth(`${prefix} ${light} ${focused ? theme.fg("accent", theme.bold(name)) : name}  ${mode}${live}`, panelWidth));
					}
					return out;
				};

				const renderConfiguration = (panelWidth: number): string[] => {
					const out: string[] = [theme.fg("text", theme.bold(outputEditor ? "Output Contract editor" : "Role configuration"))];
					const push = (text = ""): void => out.push(truncateToWidth(text, panelWidth));
					if (!selected) { push(theme.fg("muted", " No role selected.")); return out; }
					if (outputEditor) {
						const choice = outputEditor.choice;
						push(`${colorDot(selected.color)} ${theme.bold(dashboardAgentIdentity(selected).primary)} · ${outputEditor.stage === "edit" ? "Edit" : "Review"}`);
						push();
						if (outputEditor.stage === "edit") {
							push(`${outputEditor.row === 0 ? theme.fg("accent", "❯") : " "} Contract   ${choice}`);
							push(`${outputEditor.row === 1 ? theme.fg("accent", "❯") : " "} Result view ${outputEditor.draft.returns ? (effectiveOutputView(outputEditor) === "readable" ? "Readable" : "Exact JSON") : "Not applicable"}`);
							if (choice === "Custom" && outputEditor.customMode === "guided") {
								push();
								push(theme.fg("text", theme.bold("Fields · ordered")));
								if (!outputEditor.custom?.fields.length) push(theme.fg("muted", " No fields yet."));
								for (const [fieldIndex, field] of (outputEditor.custom?.fields ?? []).entries()) {
									const prefix = outputEditor.row === fieldIndex + 2 ? theme.fg("accent", "❯") : " ";
									push(`${prefix} ${field.name || "<empty>"} · ${field.type} · ${field.required ? "required" : "optional"}`);
								}
								push();
								if (outputEditor.naming) push(theme.fg("accent", `${outputEditor.naming.kind === "add" ? "Add" : "Rename"} field: ${outputEditor.naming.value}▏`));
								push(theme.fg("dim", `${km.label("new", kb)} add  ${km.label("edit", kb)} rename  ${km.label("delete", kb)} delete  ${km.label("toggle", kb)} required`));
								push(theme.fg("dim", `${km.label("reorderUp", kb)}/${km.label("reorderDown", kb)} reorder  ${km.label("left", kb)}/${km.label("right", kb)} type`));
							} else if (choice === "Custom") {
								push();
								push(theme.fg("warning", "This Custom schema is outside the guided flat-field subset."));
								push(theme.fg("dim", "It remains exact and preserve-only unless explicitly replaced."));
								push(theme.fg("dim", `${km.label("new", kb)} replace with an empty guided Custom`));
							}
							push();
							if (outputEditor.message) push(theme.fg("error", outputEditor.message));
							push(theme.fg("dim", `${km.label("up", kb)}/${km.label("down", kb)} select  ${km.label("confirm", kb)} review  ${km.label("cancel", kb)} discard`));
						} else {
							push(`Contract: ${choice}`);
							push(`Result view: ${outputEditor.draft.returns ? (effectiveOutputView(outputEditor) === "readable" ? "Readable" : "Exact JSON") : "Not applicable"}`);
							push();
							push(theme.fg("text", theme.bold("Markdown frontmatter outcome")));
							for (const line of outputFrontmatterPreview(outputEditor)) {
								for (const wrapped of wrapTextWithAnsi(line, Math.max(1, panelWidth))) push(theme.fg("dim", wrapped));
							}
							push();
							push(theme.fg("text", theme.bold(outputSaveConfirmation.armed ? "Confirm save" : "Ready to save")));
							push(theme.fg("dim", outputSaveConfirmation.armed ? `${km.label("confirm", kb)} again saves through the Markdown serializer` : `${km.label("confirm", kb)} twice to save`));
							push(theme.fg("dim", `${km.label("back", kb)} edit  ${km.label("cancel", kb)} discard without writing`));
						}
						return out;
					}
					push(`${colorDot(selected.color)} ${theme.bold(dashboardAgentIdentity(selected).primary)}${selected.displayName ? theme.fg("dim", ` · ${selected.name}`) : ""}`);
					push(theme.fg("dim", `Routing · ${(localAuto.get(selected.name) ?? selected.auto) ? "AUTO · model may route" : "MANUAL · slash command or current-turn explicit name"}`));
					for (const wrapped of wrapTextWithAnsi(selected.description, Math.max(1, panelWidth - 2))) push(`  ${wrapped}`);
					push();
					for (const line of accessSummary(selected)) push(line);
					push();
					push(theme.fg("text", theme.bold("Source")));
					push(`${selected.source} · ${selected.filePath}`);
					push();
					push(theme.fg("text", theme.bold("Actions")));
					push(`${km.label("contract", kb)} contract  ${km.label("edit", kb)} configure  ${km.label("toggle", kb)} route`);
					push(`${km.label("open", kb)} open source`);
					push(`${km.label("new", kb)} new role  ${km.label("delete", kb)} delete  ${km.label("settings", kb)} preferences`);
					return out;
				};

				const renderOutput = (panelWidth: number): string[] => {
					const out: string[] = [theme.fg("text", theme.bold(outputEditor ? "Sample output" : "Output contract"))];
					const push = (text = ""): void => out.push(truncateToWidth(text, panelWidth));
					if (!selected) { push(theme.fg("muted", " No role selected.")); return out; }
					if (outputEditor) {
						const sample = outputSamplePreview(outputEditor);
						push(theme.fg("text", theme.bold("Readable")));
						for (const line of sample.readable) push(line);
						push();
						push(theme.fg("text", theme.bold("Exact JSON")));
						for (const line of sample.exact) push(theme.fg("dim", line));
						push();
						push(theme.fg("text", theme.bold("Latest / live status")));
					} else {
						const preset = selected.returns ? classifyResultPreset(selected.returns) : undefined;
						push(`Contract: ${selected.returns ? preset ?? "Custom" : "None"}`);
						push(`View: ${selected.returns ? selected.resultView ?? `inherit (${env.state.getResultView()})` : "not applicable"}`);
						if (selected.returns) for (const line of outputContractSummary(selected.returns)) push(theme.fg("dim", line));
						push();
						push(theme.fg("text", theme.bold("Latest / live status")));
					}
					const live = active.get(selected.name) ?? [];
					if (!live.length) push(theme.fg("dim", "No active execution"));
					for (const node of live) {
						const elapsed = floorDashboardElapsed(Date.now() - (node.startedAt ?? node.plannedAt)) / 1_000;
						const activity = node.activity.tool ? `${node.activity.tool}${node.activity.text ? ` · ${node.activity.text}` : ""}` : node.activity.text ?? node.activity.type;
						push(`${colorize(selected.color, "●")} ${elapsed}s · ${activity}`);
					}
					const latest = env.latestRuns?.().get(selected.name);
					if (latest) {
						push(`Latest: ${latest.status} · ${Math.round(latest.durationMs / 1000)}s`);
						if (latest.task) push(theme.fg("dim", `Task: ${latest.task}`));
					} else push(theme.fg("dim", "No completed run"));
					const stats = env.runStats?.().get(selected.name);
					push(stats ? `${stats.runs} recent runs · ${stats.failed} failed · ${Math.round(stats.avgDurationMs / 1000)}s average${env.state.getShowCosts() ? ` · $${stats.totalCost.toFixed(4)}` : ""}` : theme.fg("dim", "No recent runs · 30 days"));
					return out;
				};

				if (width >= WIDE_BREAKPOINT) {
					const leftWidth = Math.min(30, Math.max(22, Math.floor(width * 0.25)));
					const remaining = width - leftWidth - 6;
					const centerWidth = Math.floor(remaining * 0.54);
					const rightWidth = remaining - centerWidth;
					const panels = [renderRoster(leftWidth), renderConfiguration(centerWidth), renderOutput(rightWidth)];
					for (let row = 0; row < Math.max(...panels.map((panel) => panel.length)); row++) {
						const cells = panels.map((panel, column) => {
							const panelWidth = [leftWidth, centerWidth, rightWidth][column];
							const cell = panel[row] ?? "";
							return cell + " ".repeat(Math.max(0, panelWidth - visibleWidth(cell)));
						});
						add(`${cells[0]} ${theme.fg("dim", "│")} ${cells[1]} ${theme.fg("dim", "│")} ${cells[2]}`);
					}
				} else {
					const viewIndex = narrowViews.indexOf(narrowView);
					add(theme.fg("dim", ` ${narrowView === "roles" ? "Roles" : narrowView === "configure" ? "Configure" : "Output & status"} ${viewIndex + 1}/3 · ${km.label("left", kb)}/${km.label("right", kb)} switch view`));
					const panel = narrowView === "roles" ? renderRoster(width) : narrowView === "configure" ? renderConfiguration(width) : renderOutput(width);
					for (const line of panel) add(line);
				}

				add();
				if (outputEditor) {
					add(theme.fg("dim", ` ${km.label("preview", kb)} narrow editor/preview  ${km.label("confirm", kb)} ${outputEditor.naming ? "accept name" : outputEditor.stage === "edit" ? "review" : "confirm save"}  ${km.label("cancel", kb)} ${outputEditor.naming ? "cancel name" : "discard"}`));
				} else if (help) {
					const hint = (key: string, label: string): void => add(`   ${theme.fg("accent", truncateToWidth(key, 8).padEnd(8))} ${theme.fg("dim", label)}`);
					add(theme.fg("text", theme.bold("Role actions")));
					hint(km.label("delete", kb), "delete");
					hint(km.label("contract", kb), "edit Output Contract in Studio");
					hint(km.label("edit", kb), "configure");
					hint(km.label("open", kb), "open source");
					hint(km.label("toggle", kb), "stage auto-routing change");
					add(theme.fg("text", theme.bold("Studio actions")));
					hint(`${km.label("confirm", kb)}${km.label("confirm", kb)}`, "apply staged auto-routing changes");
					hint(`${km.label("cancel", kb)}${km.label("cancel", kb)}`, "discard staged auto-routing changes");
					hint(km.label("new", kb), "new role");
					hint(km.label("settings", kb), "preferences");
					add(theme.fg("text", theme.bold("Navigation")));
					hint(`${km.label("left", kb)}/${km.label("right", kb)}`, "switch focused view on narrow screens");
					hint(`${km.label("up", kb)}/${km.label("down", kb)}`, "select role");
				} else {
					const actions = selected
						? `${km.label("contract", kb)} contract  ${km.label("delete", kb)} delete  ${km.label("edit", kb)} configure  ${km.label("new", kb)} new  ${km.label("open", kb)} open  ${km.label("toggle", kb)} route  ${km.label("settings", kb)} preferences  ${km.label("help", kb)} help`
						: `${km.label("new", kb)} new  ${km.label("settings", kb)} preferences  ${km.label("help", kb)} help`;
					add(theme.fg("dim", ` ${actions}`));
					if (staged > 0) add(theme.fg("dim", " Confirm has priority over Contract while routing changes are staged."));
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
	const discover = env.discover ?? (() => discoverAgents(ctx.cwd, { includeProject: (ctx as any).isProjectTrusted?.() ?? false }).agents);
	while (true) {
		const agents = [...discover()].sort((a, b) => a.name.localeCompare(b.name));
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
		if (exit.kind === "saveOutput") {
			try {
				(env.persistOutput ?? persistOutputEditor)(exit.agent, exit.draft);
				ctx.ui.notify(`Saved Output Contract for ${exit.agent.name}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : `Could not save ${exit.agent.name}`, "error");
			}
		} else if (exit.kind === "editAgent") {
			const edited = await (env.editWorkbench ?? editAgentWorkbench)(ctx, env.km, exit.agent, auto.get(exit.agent.name));
			if (edited) {
				if (edited.oldName !== edited.newName) auto.delete(edited.oldName);
				auto.set(edited.newName, edited.auto);
				selected = edited.newName;
			}
		} else if (exit.kind === "newAgent") {
			await (env.newWorkbench ?? newAgentWorkbench)(ctx, env.km);
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
