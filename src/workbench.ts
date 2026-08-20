import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { agentMutationRefusal, materializeUserOverride, renameUserAgentFile, serializeAgent, updateAgentFile, writeAgentFile } from "./agent-writer.ts";
import { applyCustomToolSelection, createAgentDraft, draftFromAgent, draftToWritable, parseCustomReturns, RETURNS_PRESETS, type AgentDraft, validateAgentDraft } from "./agent-draft.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { runAgent } from "./engine.ts";
import { pickColor, pickMulti, pickTools } from "./pickers.ts";
import { TwoPressConfirmation } from "./two-press-confirmation.ts";

export const WORKBENCH_STAGES = ["Identity", "Routing", "Capabilities", "Instructions", "Output", "Review"] as const;
export type WorkbenchStage = typeof WORKBENCH_STAGES[number];
export interface WorkbenchState { stage: number; selected: number }
export type WorkbenchIntent = { action: "cancel" | "back" | "edit" | "suggest" | "save"; field?: string };
export type WorkbenchMode = { kind: "create" } | { kind: "edit"; agent: AgentConfig; effectiveAuto?: boolean };
export interface WorkbenchEditResult { oldName: string; newName: string; auto: boolean }
export type EditPersistenceDecision =
	| { kind: "refuse"; message: string }
	| { kind: "bundled-override" }
	| { kind: "user-update" }
	| { kind: "user-rename" };

export function workbenchLabels(mode: WorkbenchMode): { title: string; action: string; committed: string } {
	return mode.kind === "create"
		? { title: "Create a new subagent", action: "Create", committed: "create" }
		: { title: `Edit ${mode.agent.name}`, action: "Save", committed: "save" };
}

/** Preserve available order, then append saved values that are currently unavailable. */
export function mergeSavedChoices(available: readonly string[], saved: readonly string[]): Array<{ name: string; note?: string }> {
	const names = [...new Set(available.filter(Boolean))];
	const choices = names.map((name) => ({ name } as { name: string; note?: string }));
	for (const name of saved) if (name && !names.includes(name)) {
		names.push(name);
		choices.push({ name, note: "(currently unavailable; preserved)" });
	}
	return choices;
}

export function agentForEdit(agent: AgentConfig, effectiveAuto: boolean | undefined): AgentConfig {
	return { ...agent, auto: effectiveAuto ?? agent.auto };
}

export function editPersistenceDecision(agent: Pick<AgentConfig, "source" | "name">, nextName: string): EditPersistenceDecision {
	const refusal = agentMutationRefusal(agent, "edit");
	if (refusal) return { kind: "refuse", message: refusal };
	if (agent.source === "bundled") return nextName === agent.name
		? { kind: "bundled-override" }
		: { kind: "refuse", message: "A bundled role cannot be renamed. Create a new role instead." };
	return nextName === agent.name ? { kind: "user-update" } : { kind: "user-rename" };
}

/** Existing unsupported schemas are grandfathered until the user intentionally changes Output. */
export function validateWorkbenchDraft(draft: AgentDraft, mode: WorkbenchMode) {
	const issues = validateAgentDraft(draft);
	if (mode.kind !== "edit" || !isDeepStrictEqual(draft.returns, mode.agent.returns)) return issues;
	return issues.filter((issue) => issue.field !== "returns");
}

const STAGE_ROWS: readonly (readonly string[])[] = [
	["name", "displayName", "color"],
	["auto", "description"],
	["access", "model", "fallback", "thinking", "conventions", "spawn"],
	["systemPrompt"],
	["output"],
	["save"],
];

export function moveWorkbench(state: WorkbenchState, delta: number): WorkbenchState {
	const count = STAGE_ROWS[state.stage].length;
	return { ...state, selected: (state.selected + delta + count) % count };
}

export function advanceWorkbench(state: WorkbenchState): WorkbenchState {
	return state.stage >= WORKBENCH_STAGES.length - 1 ? state : { stage: state.stage + 1, selected: 0 };
}

export function retreatWorkbench(state: WorkbenchState): WorkbenchState {
	return state.stage === 0 ? state : { stage: state.stage - 1, selected: 0 };
}

/** Preserve registry order while removing duplicate provider/model entries. */
export function scopedModelNames(models: readonly { provider: string; id: string }[]): string[] {
	return [...new Set(models.map((model) => `${model.provider}/${model.id}`))];
}

export function workbenchModelNames(ctx: Pick<ExtensionContext, "modelRegistry"> & { scopedModels?: readonly { model: { provider: string; id: string } }[] }): string[] {
	const scoped = ctx.scopedModels?.map((entry) => entry.model) ?? [];
	const available = scoped.length > 0 ? scoped : (ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll());
	return scopedModelNames(available);
}

/** Derive bounded thinking choices from the selected model, or the inherited parent model. */
export function workbenchThinkingLevels(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, selectedModel: string): string[] {
	let model = ctx.model;
	if (selectedModel) {
		const slash = selectedModel.indexOf("/");
		if (slash < 1 || slash === selectedModel.length - 1) return [];
		model = ctx.modelRegistry.find(selectedModel.slice(0, slash), selectedModel.slice(slash + 1));
		if (!model) return [];
	}
	return model ? getSupportedThinkingLevels(model).map(String) : [];
}

/** A generated value is provisional until the editor explicitly returns a value. */
export function acceptProvisionalSuggestion(current: string, edited: string | undefined): string {
	return edited === undefined ? current : edited;
}

export function workbenchOutputName(draft: AgentDraft): string {
	if (!draft.returns) return "None";
	return RETURNS_PRESETS.find((preset) => isDeepStrictEqual(preset.schema, draft.returns))?.name ?? "Custom";
}

function rowValue(field: string, draft: AgentDraft, mode: WorkbenchMode): string {
	if (field === "name") return draft.name || "(required)";
	if (field === "displayName") return draft.displayName || "(none)";
	if (field === "color") return draft.color;
	if (field === "auto") return draft.auto ? "proactive" : "manual only";
	if (field === "description") return draft.description || "(required)";
	if (field === "access") {
		if (draft.access === "unset") return "not selected";
		return draft.toolMode === "custom" ? `${draft.access}, custom: ${draft.tools.join(", ") || "none"}` : draft.toolMode === "none" ? `${draft.access}, no tools` : `${draft.access}, default tools`;
	}
	if (field === "model") return draft.model || "inherited";
	if (field === "fallback") return draft.fallback.join(" → ") || "none";
	if (field === "thinking") return draft.thinking || "inherited";
	if (field === "conventions") return draft.conventions ? "on" : "off";
	if (field === "spawn") return draft.spawn.join(", ") || "none";
	if (field === "systemPrompt") return draft.systemPrompt || "(required)";
	if (field === "output") return workbenchOutputName(draft);
	return `Review and ${workbenchLabels(mode).committed}`;
}

export function reviewPreview(draft: AgentDraft, width: number, mode: WorkbenchMode = { kind: "create" }): string[] {
	const accessValid = (draft.access === "readonly" || draft.access === "writable")
		&& (draft.toolMode === "defaults" || draft.toolMode === "none" || (draft.toolMode === "custom" && draft.tools.length > 0));
	const persistedAuto = mode.kind === "edit" ? mode.agent.auto : draft.auto;
	const writable = accessValid ? draftToWritable({ ...draft, auto: persistedAuto }) : undefined;
	const pendingAuto = mode.kind === "edit" && draft.auto !== mode.agent.auto
		? [`Pending dashboard confirmation only: Auto routing will become ${draft.auto ? "proactive" : "manual"}.`]
		: [];
	const permissions = draft.access === "unset"
		? "unset"
		: draft.toolMode === "custom"
			? `${draft.access}, custom (${draft.tools.join(", ") || "no tools selected"})`
			: draft.toolMode === "none" ? `${draft.access}, no tools` : `${draft.access}, default tools`;
	const summaries = [
		`Routing: ${persistedAuto === false ? "manual" : "proactive"}; ${draft.description.trim()}`,
		...pendingAuto,
		`Permissions: ${permissions}`,
		`Model: ${draft.model.trim() || "inherited"}; fallback ${draft.fallback.join(" → ") || "none"}; thinking ${draft.thinking.trim() || "inherited"}`,
		`Delegation: conventions ${draft.conventions ? "on" : "off"}; spawn ${draft.spawn.join(", ") || "none"}`,
		`Output: ${workbenchOutputName(draft)}`,
		...(writable
			? ["Serialized definition:", ...serializeAgent(writable).trimEnd().split("\n").map((line) => `  ${line}`)]
			: ["Serialized definition unavailable until valid tool access is selected."]),
	];
	return summaries.flatMap((text) => wrapTextWithAnsi(text, Math.max(1, width)).map((line) => truncateToWidth(line, width)));
}

const FIELD_LABELS: Record<string, string> = {
	name: "Name", displayName: "Display Name", color: "Color", auto: "Auto routing",
	description: "Description", access: "Tool access", model: "Model", fallback: "Fallback",
	thinking: "Thinking", conventions: "Conventions", spawn: "Spawn", systemPrompt: "System Prompt",
	output: "Output", save: "Save",
};

export function renderWorkbench(draft: AgentDraft, state: WorkbenchState, width: number, mode: WorkbenchMode = { kind: "create" }): string[] {
	width = Math.max(1, width);
	const labels = workbenchLabels(mode);
	const lines = [
		`${labels.title} · ${WORKBENCH_STAGES[state.stage]}   ${state.stage + 1}/6`,
		"b    back",
		"esc  discard",
		"⏎    edit / next",
		"↑↓   select",
		"",
	];
	if (state.stage === 5) lines.push(`${labels.action}: press ⏎ twice`, "", ...reviewPreview(draft, width, mode));
	else {
		STAGE_ROWS[state.stage].forEach((field, index) => {
			const label = field === "save" ? labels.action : FIELD_LABELS[field];
			lines.push(`${index === state.selected ? ">" : " "} ${label}: ${rowValue(field, draft, mode)}`);
		});
		const selected = STAGE_ROWS[state.stage][state.selected];
		if (selected === "description" || selected === "systemPrompt") lines.push("", "Tab  Want a suggestion?");
	}
	return lines.map((line) => truncateToWidth(line, width));
}

function showStage(ctx: ExtensionContext, draft: AgentDraft, initial: WorkbenchState, mode: WorkbenchMode): Promise<{ intent: WorkbenchIntent; state: WorkbenchState }> {
	return ctx.ui.custom((tui: any, theme: any, injected: any, done: (result: { intent: WorkbenchIntent; state: WorkbenchState }) => void) => {
		let state = initial;
		let cached: string[] | undefined;
		let cachedWidth: number | undefined;
		const keys = injected;
		const confirmation = new TwoPressConfirmation({
			isConfirm: (data) => keys.matches(data, "tui.select.confirm"),
			// Escape always discards the draft; it is not a two-press action here.
			isCancel: () => false,
		});
		const refresh = () => {
			cached = undefined;
			cachedWidth = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (state.stage === 5) {
				const result = confirmation.handle(data);
				if (result.kind === "commit") return done({ intent: { action: "save" }, state });
				if (result.kind === "arm") { refresh(); return; }
				if (result.kind === "disarm") refresh();
			}
			if (keys.matches(data, "tui.select.cancel")) return done({ intent: { action: "cancel" }, state });
			if (data === "b") return done({ intent: { action: "back" }, state });
			const selected = STAGE_ROWS[state.stage][state.selected];
			if (keys.matches(data, "tui.input.tab") && (selected === "description" || selected === "systemPrompt")) {
				return done({ intent: { action: "suggest", field: selected }, state });
			}
			if (keys.matches(data, "tui.select.up")) { state = moveWorkbench(state, -1); refresh(); return; }
			if (keys.matches(data, "tui.select.down")) { state = moveWorkbench(state, 1); refresh(); return; }
			if (!keys.matches(data, "tui.select.confirm") || state.stage === 5) return;
			done({ intent: { action: "edit", field: STAGE_ROWS[state.stage][state.selected] }, state });
		}
		return {
			render(width: number) {
				width = Math.max(1, width);
				if (!cached || cachedWidth !== width) {
					cachedWidth = width;
					const body = renderWorkbench(draft, state, Math.max(1, width - 2), mode);
					cached = [
						theme.fg(confirmation.borderColor(), "─".repeat(width)),
						...body.map((line) => truncateToWidth(` ${line}`, width)),
						theme.fg(confirmation.borderColor(), "─".repeat(width)),
					];
					if (state.stage === 5 && confirmation.armed === "confirm") cached.splice(-1, 0, truncateToWidth(theme.fg("success", ` ⏎ again to ${workbenchLabels(mode).committed}`), width));
				}
				return cached;
			},
			invalidate() { cached = undefined; cachedWidth = undefined; },
			handleInput,
		};
	});
}

async function draftSuggestion(ctx: ExtensionContext, draft: AgentDraft, field: "description" | "systemPrompt"): Promise<string | undefined> {
	const task = field === "description"
		? `Write a single-line "when to delegate" description for a subagent named "${draft.name}", using "use proactively"/"always use for" cues so a parent AI knows when to call it. Output only the line.`
		: `Write a concise system prompt for a subagent named "${draft.name}" described as: ${draft.description}. Cover its role, a few clear rules (including tool use), and how it should format its final output. Output only the prompt.`;
	return ctx.ui.custom<string | undefined>((tui: any, theme: any, injected: any, done: (value: string | undefined) => void) => {
		const abort = new AbortController();
		const keys = injected;
		let closed = false;
		void (async () => {
			try {
				const handle = await runAgent({
					agent: { name: "drafter", description: "drafter", thinking: "high", fallback: [], auto: true, tools: undefined, readonly: true, color: "purple", conventions: false, spawn: [], systemPrompt: "You draft a single piece of text exactly as instructed. Output ONLY the requested text — no preamble, no fences.", source: "user", filePath: "" },
					task, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, conventions: false, signal: abort.signal, onEvent: () => {},
				});
				const result = await handle.promise;
				if (!closed) done(result.ok ? result.finalText.trim().replace(/^```[a-z]*\n/i, "").replace(/\n```$/i, "").trim() : undefined);
			} catch {
				if (!closed) done(undefined);
			}
		})();
		return {
			render(width: number) { return [truncateToWidth(theme.fg("accent", "Thinking super duper hard…"), width), truncateToWidth(theme.fg("dim", "esc  cancel suggestion"), width)]; },
			invalidate() {},
			handleInput(data: string) { if (keys.matches(data, "tui.select.cancel")) { closed = true; abort.abort(); done(undefined); } },
		};
	});
}

async function applySuggestionFlow(ctx: ExtensionContext, draft: AgentDraft, field: "description" | "systemPrompt"): Promise<boolean> {
	const current = draft[field];
	const suggestion = await draftSuggestion(ctx, draft, field);
	if (!suggestion) return false;
	const edited = await ctx.ui.editor("Review suggestion — submit to accept, esc to keep the current value", suggestion);
	if (edited === undefined) return false;
	draft[field] = acceptProvisionalSuggestion(current, edited);
	return true;
}

async function editField(ctx: ExtensionContext, draft: AgentDraft, field: string, models: string[], roster: string[]): Promise<boolean> {
	if (field === "name" || field === "displayName") {
		const value = await ctx.ui.input(field === "name" ? "Role / command identity" : "Display name (optional)", draft[field]);
		if (value === undefined) return false;
		draft[field] = value;
	} else if (field === "color") {
		const value = await pickColor(ctx, draft.color);
		if (!value) return false;
		draft.color = value;
	} else if (field === "auto" || field === "conventions") {
		draft[field] = !draft[field];
	} else if (field === "description" || field === "systemPrompt") {
		const current = draft[field];
		const value = await ctx.ui.editor(`${field === "description" ? "When to delegate" : "Agent instructions"} — type /suggest here to use the original AI drafter`, current);
		if (value === "/suggest") {
			return applySuggestionFlow(ctx, draft, field);
		} else {
			if (value === undefined) return false;
			draft[field] = value;
		}
	} else if (field === "access") {
		const choice = await ctx.ui.select("Tool access", [
			"read-only, default tools",
			"read-only, custom tools",
			"read-only, no tools",
			"writable, Pi defaults",
			"writable, custom tools",
			"writable, no tools",
		]);
		if (choice === undefined) return false;
		const access = choice.startsWith("read-only") ? "readonly" : "writable";
		if (!choice.includes("custom")) {
			draft.access = access;
			draft.toolMode = choice.includes("no tools") ? "none" : "defaults";
			draft.tools = [];
		} else {
			const selected = await pickTools(ctx, draft.tools);
			if (selected === undefined) return false;
			const result = applyCustomToolSelection(draft, selected, access);
			if ("error" in result) { ctx.ui.notify(result.error, "error"); return false; }
			draft.access = result.access;
			draft.toolMode = result.toolMode;
			draft.tools = result.tools;
		}
	} else if (field === "model") {
		const choices = mergeSavedChoices(models, [draft.model]);
		const labels = ["inherited", ...choices.map((choice) => choice.note ? `${choice.name} ${choice.note}` : choice.name)];
		const choice = await ctx.ui.select("Model", labels);
		if (choice === undefined) return false;
		draft.model = choice === "inherited" ? "" : choices[labels.indexOf(choice) - 1].name;
	} else if (field === "fallback") {
		const value = await pickMulti(ctx, "Fallback models", mergeSavedChoices(models, draft.fallback), draft.fallback, "tried in selected order on provider errors");
		if (value === undefined) return false;
		draft.fallback = value;
	} else if (field === "thinking") {
		const choices = mergeSavedChoices(workbenchThinkingLevels(ctx, draft.model), [draft.thinking]);
		const labels = ["inherited", ...choices.map((choice) => choice.note ? `${choice.name} ${choice.note}` : choice.name)];
		const choice = await ctx.ui.select("Thinking", labels);
		if (choice === undefined) return false;
		draft.thinking = choice === "inherited" ? "" : choices[labels.indexOf(choice) - 1].name;
	} else if (field === "spawn") {
		const value = await pickMulti(ctx, "Spawn targets", mergeSavedChoices(roster, draft.spawn), draft.spawn);
		if (value === undefined) return false;
		draft.spawn = value;
	} else if (field === "output") {
		const choice = await ctx.ui.select("Output", ["None", "Findings", "Review", "Decision", "Custom"]);
		if (!choice) return false;
		if (choice === "None") draft.returns = undefined;
		else if (choice !== "Custom") draft.returns = structuredClone(RETURNS_PRESETS.find((preset) => preset.name === choice)!.schema);
		else {
			const text = await ctx.ui.editor("Custom output schema — supported JSON Schema subset", draft.returns ? JSON.stringify(draft.returns, null, 2) : "{\n  \"type\": \"object\",\n  \"properties\": {}\n}");
			if (text === undefined) return false;
			const parsed = parseCustomReturns(text);
			if (parsed.error) { ctx.ui.notify(`Custom schema rejected: ${parsed.error}`, "error"); return false; }
			draft.returns = parsed.schema;
		}
	}
	return true;
}

export function persistEditDraft(agent: AgentConfig, draft: AgentDraft): WorkbenchEditResult {
	// Dashboard owns auto staging; Edit saves every other field but returns the draft auto for the dashboard map.
	const writable = draftToWritable({ ...draft, auto: agent.auto });
	const decision = editPersistenceDecision(agent, writable.name);
	if (decision.kind === "refuse") throw new Error(decision.message);
	const updated: AgentConfig = { ...agent, ...writable };
	if (decision.kind === "bundled-override") materializeUserOverride(updated);
	else if (decision.kind === "user-update") updateAgentFile(updated);
	else renameUserAgentFile(updated);
	return { oldName: agent.name, newName: writable.name, auto: draft.auto };
}

export async function openAgentWorkbench(ctx: ExtensionContext, mode: WorkbenchMode): Promise<WorkbenchEditResult | undefined> {
	if (mode.kind === "edit") {
		const refusal = agentMutationRefusal(mode.agent, "edit");
		if (refusal) {
			ctx.ui.notify(refusal, "warning");
			return undefined;
		}
		if (mode.agent.source === "bundled") ctx.ui.notify(`Changes to ${mode.agent.name} will be saved as a user override; the bundled default is unchanged.`, "info");
	}
	const draft = mode.kind === "create" ? createAgentDraft() : draftFromAgent(agentForEdit(mode.agent, mode.effectiveAuto));
	const models = workbenchModelNames(ctx as ExtensionContext & { scopedModels?: readonly { model: { provider: string; id: string } }[] });
	const roster = [...new Set(discoverAgents(ctx.cwd, { includeProject: (ctx as any).isProjectTrusted?.() ?? false }).agents.map((agent) => agent.name))];
	let state: WorkbenchState = { stage: 0, selected: 0 };
	while (true) {
		const { intent, state: latest } = await showStage(ctx, draft, state, mode);
		state = latest;
		if (intent.action === "cancel") return undefined;
		if (intent.action === "back") { state = retreatWorkbench(state); continue; }
		if (intent.action === "suggest" && (intent.field === "description" || intent.field === "systemPrompt")) {
			await applySuggestionFlow(ctx, draft, intent.field);
			continue;
		}
		if (intent.action === "edit" && intent.field) {
			const accepted = await editField(ctx, draft, intent.field, models, roster);
			if (accepted) {
				const lastRow = state.selected === STAGE_ROWS[state.stage].length - 1;
				state = lastRow ? advanceWorkbench(state) : moveWorkbench(state, 1);
			}
			continue;
		}
		if (intent.action !== "save") continue;
		const issues = validateWorkbenchDraft(draft, mode);
		if (issues.length) {
			ctx.ui.notify(issues[0].message, "error");
			const field = issues[0].field === "returns" ? "output" : issues[0].field;
			const stage = STAGE_ROWS.findIndex((rows) => rows.includes(field));
			state = { stage: Math.max(0, stage), selected: Math.max(0, STAGE_ROWS[stage]?.indexOf(field) ?? 0) };
			continue;
		}
		if (mode.kind === "edit") {
			const decision = editPersistenceDecision(mode.agent, draft.name.trim());
			if (decision.kind === "refuse") {
				ctx.ui.notify(decision.message, "warning");
				state = { stage: 0, selected: 0 };
				continue;
			}
			try {
				const renamed = persistEditDraft(mode.agent, draft);
				ctx.ui.notify(`Saved ${draft.name.trim()}${decision.kind === "bundled-override" ? " as a user override" : ""}`, "info");
				return renamed;
			} catch (error) {
				const collision = (error as NodeJS.ErrnoException).code === "EEXIST";
				ctx.ui.notify(collision ? "That role name already has a user definition." : `Could not save agent: ${error instanceof Error ? error.message : String(error)}`, "error");
				state = { stage: 0, selected: 0 };
				continue;
			}
		}
		try {
			const file = writeAgentFile(draftToWritable(draft), path.join(getAgentDir(), "agents"));
			ctx.ui.notify(`Created "${draft.name.trim()}" → ${file}. Run /reload to use /${path.basename(file, ".md")}.`, "info");
			return undefined;
		} catch (error) {
			const collision = (error as NodeJS.ErrnoException).code === "EEXIST";
			ctx.ui.notify(collision ? "That role name already has a user definition." : `Could not create agent: ${error instanceof Error ? error.message : String(error)}`, "error");
			state = { stage: 0, selected: 0 };
		}
	}
}

export function newAgentWorkbench(ctx: ExtensionContext): Promise<void> {
	return openAgentWorkbench(ctx, { kind: "create" }).then(() => undefined);
}

export function editAgentWorkbench(ctx: ExtensionContext, agent: AgentConfig, effectiveAuto?: boolean): Promise<WorkbenchEditResult | undefined> {
	return openAgentWorkbench(ctx, { kind: "edit", agent, effectiveAuto });
}
