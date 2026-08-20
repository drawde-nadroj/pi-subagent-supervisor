import { isDeepStrictEqual } from "node:util";
import { draftFromAgent, type AgentDraft } from "./agent-draft.ts";
import { addCustomField, customSchemaFromFields, cycleCustomFieldType, decodeCustomSchema, deleteCustomField, isCanonicalArrayIndexName, moveCustomField, renameCustomField, toggleCustomFieldRequired, validateCustomFields, type CustomSchemaEditorState } from "./custom-schema-editor.ts";
import { materializeUserOverride, readUserAgentFile, readUserOverride, serializeOutputFrontmatter, updateAgentFile } from "./agent-writer.ts";
import type { AgentConfig } from "./agents.ts";
import { classifyResultPreset, describeStructuredResult, resultSections, RETURNS_PRESETS, type ResultPreset, type ResultView } from "./result-view.ts";
import type { ReturnsSchema } from "./returns.ts";

export type OutputContractChoice = "None" | ResultPreset | "Custom";
export type OutputEditorStage = "edit" | "review";

export interface OutputFieldNaming {
	kind: "add" | "rename";
	value: string;
	index?: number;
}

export interface OutputEditorState {
	draft: AgentDraft;
	stage: OutputEditorStage;
	choice: OutputContractChoice;
	/** Contract, result view, then guided Custom fields. */
	row: number;
	/** Original Custom remains available unchanged until explicit guided replacement. */
	preservedCustom?: ReturnsSchema;
	custom?: CustomSchemaEditorState;
	customMode?: "guided" | "preserve-only";
	naming?: OutputFieldNaming;
	message?: string;
	globalView: ResultView;
}

export interface OutputSamplePreview {
	readable: string[];
	exact: string[];
}

function cloneSchema(schema: ReturnsSchema): ReturnsSchema {
	return structuredClone(schema);
}

export function outputContractChoice(draft: Pick<AgentDraft, "returns">): OutputContractChoice {
	if (!draft.returns) return "None";
	return classifyResultPreset(draft.returns) ?? "Custom";
}

export function createOutputEditor(agent: AgentConfig, globalView: ResultView): OutputEditorState {
	const draft = draftFromAgent(agent);
	const choice = outputContractChoice(draft);
	const preservedCustom = choice === "Custom" && draft.returns ? cloneSchema(draft.returns) : undefined;
	const decoded = preservedCustom ? decodeCustomSchema(preservedCustom) : undefined;
	return {
		draft,
		stage: "edit",
		choice,
		row: 0,
		preservedCustom,
		custom: decoded?.kind === "compatible" ? decoded.editor : undefined,
		customMode: decoded ? (decoded.kind === "compatible" ? "guided" : "preserve-only") : undefined,
		globalView,
	};
}

export function outputContractChoices(_state: Pick<OutputEditorState, "preservedCustom">): OutputContractChoice[] {
	return ["None", "Findings", "Review", "Decision", "Custom"];
}

export function setOutputContract(state: OutputEditorState, choice: OutputContractChoice): void {
	state.choice = choice;
	state.message = undefined;
	if (choice === "None") {
		state.draft.returns = undefined;
		state.draft.resultView = undefined;
		return;
	}
	if (choice === "Custom") {
		if (state.customMode === "guided" && state.custom) state.draft.returns = customSchemaFromFields(state.custom.fields);
		else if (state.preservedCustom) state.draft.returns = cloneSchema(state.preservedCustom);
		else {
			state.custom = { fields: [], selected: -1 };
			state.customMode = "guided";
			state.draft.returns = customSchemaFromFields([]);
		}
		state.row = 0;
		state.message = undefined;
		return;
	}
	const preset = RETURNS_PRESETS.find((item) => item.name === choice);
	if (!preset) throw new Error(`Unknown output contract: ${choice}`);
	state.draft.returns = cloneSchema(preset.schema);
}

export function effectiveOutputView(state: Pick<OutputEditorState, "draft" | "globalView">): ResultView {
	return state.draft.resultView ?? state.globalView;
}

function syncCustomSchema(state: OutputEditorState): void {
	if (state.customMode === "guided" && state.custom && state.choice === "Custom") {
		state.draft.returns = customSchemaFromFields(state.custom.fields);
	}
	state.message = undefined;
}

export function selectedCustomFieldIndex(state: OutputEditorState): number | undefined {
	if (state.choice !== "Custom" || state.customMode !== "guided" || !state.custom || state.row < 2) return undefined;
	const index = state.row - 2;
	return state.custom.fields[index] ? index : undefined;
}

export function cycleOutputEditor(state: OutputEditorState, direction: -1 | 1): void {
	if (state.stage !== "edit" || state.naming) return;
	if (state.row === 0) {
		const choices = outputContractChoices(state);
		const index = Math.max(0, choices.indexOf(state.choice));
		setOutputContract(state, choices[(index + direction + choices.length) % choices.length]!);
		return;
	}
	if (state.row === 1) {
		if (!state.draft.returns) return;
		state.draft.resultView = effectiveOutputView(state) === "readable" ? "exact" : "readable";
		return;
	}
	const index = selectedCustomFieldIndex(state);
	if (index !== undefined && state.custom) {
		cycleCustomFieldType(state.custom, index, direction);
		syncCustomSchema(state);
	}
}

export function moveOutputEditor(state: OutputEditorState, direction: -1 | 1): void {
	if (state.stage !== "edit" || state.naming) return;
	const fieldCount = state.choice === "Custom" && state.customMode === "guided" ? state.custom?.fields.length ?? 0 : 0;
	state.row = Math.max(0, Math.min(1 + fieldCount, state.row + direction));
}

export function replaceCustomWithGuided(state: OutputEditorState): void {
	if (state.choice !== "Custom") return;
	state.custom = { fields: [], selected: -1 };
	state.customMode = "guided";
	state.row = 0;
	syncCustomSchema(state);
}

export function beginOutputFieldNaming(state: OutputEditorState, kind: "add" | "rename"): void {
	if (state.stage !== "edit" || state.choice !== "Custom" || state.customMode !== "guided" || !state.custom) return;
	if (kind === "add") state.naming = { kind, value: "" };
	else {
		const index = selectedCustomFieldIndex(state);
		if (index === undefined) return;
		state.naming = { kind, index, value: state.custom.fields[index]!.name };
	}
	state.message = undefined;
}

export function appendOutputFieldName(state: OutputEditorState, text: string): void {
	if (!state.naming || /[\u0000-\u001f\u007f]/u.test(text)) return;
	if (state.naming.value.length + text.length <= 128) state.naming.value += text;
	else state.message = "Field names are limited to 128 characters.";
}

export function backspaceOutputFieldName(state: OutputEditorState): void {
	if (state.naming) state.naming.value = [...state.naming.value].slice(0, -1).join("");
}

export function cancelOutputFieldNaming(state: OutputEditorState): void {
	state.naming = undefined;
	state.message = undefined;
}

export function commitOutputFieldNaming(state: OutputEditorState): boolean {
	if (!state.naming || !state.custom) return false;
	const { kind, value, index } = state.naming;
	if (!value.trim()) {
		state.message = "Field name cannot be empty.";
		return false;
	}
	if (isCanonicalArrayIndexName(value)) {
		state.message = `Field name “${value}” is an array index and cannot preserve guided field order.`;
		return false;
	}
	const duplicate = state.custom.fields.some((field, fieldIndex) => field.name === value && (kind === "add" || fieldIndex !== index));
	if (duplicate) {
		state.message = `Field name “${value}” is already used.`;
		return false;
	}
	if (kind === "add") {
		addCustomField(state.custom, value);
		state.row = state.custom.selected + 2;
	} else if (index !== undefined) renameCustomField(state.custom, index, value);
	state.naming = undefined;
	syncCustomSchema(state);
	return true;
}

export function deleteOutputField(state: OutputEditorState): void {
	const index = selectedCustomFieldIndex(state);
	if (index === undefined || !state.custom) return;
	deleteCustomField(state.custom, index);
	state.row = state.custom.selected >= 0 ? state.custom.selected + 2 : 1;
	syncCustomSchema(state);
}

export function reorderOutputField(state: OutputEditorState, direction: -1 | 1): void {
	const index = selectedCustomFieldIndex(state);
	if (index === undefined || !state.custom) return;
	moveCustomField(state.custom, index, direction);
	state.row = state.custom.selected + 2;
	syncCustomSchema(state);
}

export function toggleOutputFieldRequired(state: OutputEditorState): void {
	const index = selectedCustomFieldIndex(state);
	if (index === undefined || !state.custom) return;
	toggleCustomFieldRequired(state.custom, index);
	syncCustomSchema(state);
}

export function reviewOutputEditor(state: OutputEditorState): boolean {
	if (state.choice === "Custom" && state.customMode === "guided" && state.custom) {
		const errors = validateCustomFields(state.custom.fields);
		if (errors.length) {
			state.message = errors[0];
			return false;
		}
	}
	state.message = undefined;
	state.stage = "review";
	return true;
}

export function editOutputEditor(state: OutputEditorState): void {
	state.stage = "edit";
}

function sampleValue(schema: ReturnsSchema, key = "value", depth = 0): unknown {
	if (schema.enum?.length) return schema.enum[0];
	if (depth >= 8) return null;
	if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => [name, sampleValue(child, name, depth + 1)]));
	if (schema.type === "array") return schema.items ? [sampleValue(schema.items, key, depth + 1)] : [];
	if (schema.type === "number") return 1;
	if (schema.type === "boolean") return true;
	return `example ${key.replace(/_/g, " ")}`;
}

/** Deterministic projections use the runtime presentation path, not a second preview formatter. */
export function outputFrontmatterPreview(state: Pick<OutputEditorState, "draft" | "globalView">): string[] {
	const persisted = serializeOutputFrontmatter(state.draft);
	if (!state.draft.returns) return [
		"returns: <removed from frontmatter>",
		"resultView: <removed from frontmatter>",
	];
	if (!state.draft.resultView) persisted.push(`resultView: <omitted; inherits ${state.globalView === "readable" ? "Readable" : "Exact JSON"}>`);
	return persisted;
}

export function outputSamplePreview(state: Pick<OutputEditorState, "draft" | "globalView">): OutputSamplePreview {
	const schema = state.draft.returns;
	if (!schema) return {
		readable: ["No structured output. The agent returns its final text."],
		exact: ["No exact JSON view without an output contract."],
	};
	const finalText = JSON.stringify(sampleValue(schema));
	const descriptor = describeStructuredResult(schema, finalText, effectiveOutputView(state));
	const sections = resultSections(finalText, descriptor, true);
	const readable = sections.find((section) => section.label === "Readable")?.text ?? finalText;
	const exact = sections.find((section) => section.label === "Exact JSON")?.text ?? finalText;
	return { readable: readable.split("\n"), exact: exact.split("\n") };
}

type OutputFields = Pick<AgentConfig, "returns" | "resultView">;

function outputFieldsEqual(left: OutputFields, right: OutputFields): boolean {
	return isDeepStrictEqual(left.returns, right.returns)
		&& (left.returns ? left.resultView : undefined) === (right.returns ? right.resultView : undefined);
}

/** Three-way merge output fields into the latest definition, then use existing ownership-safe writers. */
export function persistOutputEditor(agent: AgentConfig, draft: AgentDraft): AgentConfig | void {
	if (agent.source === "project") throw new Error("Project agent definitions are read-only. Open the source file to edit it externally.");
	const current = agent.source === "user" ? readUserAgentFile(agent) : readUserOverride(agent.name) ?? agent;

	// An untouched draft never rewrites bytes, creates an override, or reverts a concurrent output edit.
	if (outputFieldsEqual(draft, agent) || outputFieldsEqual(draft, current)) return;
	if (!outputFieldsEqual(current, agent)) {
		throw new Error(`Output Contract conflict for ${agent.name}: returns/resultView changed outside Studio. Discard and reopen before saving.`);
	}

	const returns = draft.returns ? cloneSchema(draft.returns) : undefined;
	const updated: AgentConfig = {
		...current,
		returns,
		resultView: returns ? draft.resultView : undefined,
	};
	if (current.source === "user") {
		updateAgentFile(updated);
		return;
	}
	return materializeUserOverride(updated);
}
