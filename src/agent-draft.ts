import type { WritableAgent } from "./agent-writer.ts";
import type { AgentConfig } from "./agents.ts";
import type { ReturnsSchema } from "./returns.ts";
export { RETURNS_PRESETS } from "./result-view.ts";
import { RETURNS_PRESETS } from "./result-view.ts";

export type AccessMode = "unset" | "readonly" | "writable";
export type ToolMode = "defaults" | "custom" | "none";

/** Complete, persistence-independent state for the staged creation workbench. */
export interface AgentDraft {
	name: string;
	displayName: string;
	description: string;
	model: string;
	fallback: string[];
	auto: boolean;
	returns?: ReturnsSchema;
	resultView?: import("./result-view.ts").ResultView;
	thinking: string;
	access: AccessMode;
	toolMode: ToolMode;
	tools: string[];
	color: string;
	conventions: boolean;
	spawn: string[];
	systemPrompt: string;
}

export function createAgentDraft(): AgentDraft {
	return { name: "", displayName: "", description: "", model: "", fallback: [], auto: true, resultView: undefined, thinking: "", access: "unset", toolMode: "defaults", tools: [], color: "cyan", conventions: false, spawn: [], systemPrompt: "" };
}

export function draftFromAgent(agent: AgentConfig): AgentDraft {
	const access: AccessMode = agent.readonly ? "readonly" : "writable";
	return {
		name: agent.name, displayName: agent.displayName ?? "", description: agent.description, model: agent.model ?? "", fallback: [...agent.fallback], auto: agent.auto,
		returns: agent.returns ? structuredClone(agent.returns) : undefined, resultView: agent.resultView, thinking: agent.thinking ?? "", access,
		toolMode: agent.tools === undefined ? "defaults" : agent.tools.length === 0 ? "none" : "custom", tools: [...(agent.tools ?? [])], color: agent.color,
		conventions: agent.conventions, spawn: [...agent.spawn], systemPrompt: agent.systemPrompt,
	};
}

export function draftToWritable(draft: AgentDraft): WritableAgent {
	if (draft.access === "unset") throw new Error("Tool access must be selected.");
	if (draft.access !== "readonly" && draft.access !== "writable") throw new Error(`Invalid tool access mode: ${String(draft.access)}`);
	if (draft.toolMode !== "defaults" && draft.toolMode !== "custom" && draft.toolMode !== "none") throw new Error(`Invalid tool selection mode: ${String(draft.toolMode)}`);
	if (draft.toolMode === "custom" && draft.tools.length === 0) throw new Error("Custom tool access requires at least one tool.");
	return {
		name: draft.name.trim(), displayName: draft.displayName.trim() || undefined, description: draft.description.trim(), model: draft.model.trim() || undefined,
		fallback: [...draft.fallback], auto: draft.auto, returns: draft.returns ? structuredClone(draft.returns) : undefined, ...(draft.returns && draft.resultView ? { resultView: draft.resultView } : {}), thinking: draft.thinking.trim() || undefined,
		tools: draft.toolMode === "custom" ? [...draft.tools] : draft.toolMode === "none" ? [] : undefined,
		readonly: draft.access === "readonly", color: draft.color, conventions: draft.conventions,
		spawn: [...draft.spawn], systemPrompt: draft.systemPrompt.trim(),
	};
}

/** Apply a Custom picker result without changing either permission dimension accidentally. */
export function applyCustomToolSelection(
	previous: Pick<AgentDraft, "access" | "toolMode" | "tools">,
	selected: string[] | undefined,
	access: Exclude<AccessMode, "unset">,
): Pick<AgentDraft, "access" | "toolMode" | "tools"> | { error: string } {
	if (selected === undefined) return { access: previous.access, toolMode: previous.toolMode, tools: [...previous.tools] };
	if (selected.length === 0) return { error: "Custom tool access requires at least one tool." };
	return { access, toolMode: "custom", tools: [...selected] };
}

export interface DraftIssue { field: keyof AgentDraft; message: string }

export function validateAgentDraft(draft: AgentDraft): DraftIssue[] {
	const issues: DraftIssue[] = [];
	if (!draft.name.trim()) issues.push({ field: "name", message: "Role / command is required." });
	else if (!/^[a-z0-9][a-z0-9-]*$/i.test(draft.name.trim())) issues.push({ field: "name", message: "Use letters, numbers, and hyphens only." });
	if (!draft.description.trim()) issues.push({ field: "description", message: "Routing description is required." });
	if (draft.access === "unset") issues.push({ field: "access", message: "Tool access must be selected." });
	else if (draft.access !== "readonly" && draft.access !== "writable") issues.push({ field: "access", message: "Tool access mode is invalid." });
	if (draft.toolMode !== "defaults" && draft.toolMode !== "custom" && draft.toolMode !== "none") issues.push({ field: "access", message: "Tool selection mode is invalid." });
	else if (draft.toolMode === "custom" && draft.tools.length === 0) issues.push({ field: "access", message: "Custom tool access requires at least one tool." });
	if (!draft.systemPrompt.trim()) issues.push({ field: "systemPrompt", message: "Agent instructions are required." });
	if (draft.returns) for (const message of validateReturnsSchema(draft.returns)) issues.push({ field: "returns", message });
	return issues;
}

const SCHEMA_KEYS = new Set(["type", "properties", "required", "items", "enum"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "boolean"]);

export function validateReturnsSchema(schema: unknown, path = "$", ancestors = new Set<object>()): string[] {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path}: schema must be an object`];
	if (ancestors.has(schema as object)) return [`${path}: schema must not be recursive`];
	const nextAncestors = new Set(ancestors).add(schema as object), value = schema as Record<string, unknown>, errors: string[] = [];
	for (const key of Object.keys(value)) if (!SCHEMA_KEYS.has(key)) errors.push(`${path}: unsupported keyword ${key}`);
	if (value.type !== undefined && !SCHEMA_TYPES.has(value.type as string)) errors.push(`${path}.type: unsupported type ${String(value.type)}`);
	else if (value.type === undefined && value.enum === undefined) errors.push(`${path}.type: supported type or enum is required`);
	if (value.enum !== undefined) {
		if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some((item) => typeof item !== "string" && typeof item !== "number")) errors.push(`${path}.enum: use a non-empty array of strings or numbers`);
		else if (value.type === "object" || value.type === "array" || value.type === "boolean") errors.push(`${path}.enum: ${value.type} enums are not supported`);
		else if ((value.type === "string" || value.type === "number") && value.enum.some((item) => typeof item !== value.type)) errors.push(`${path}.enum: every member must match declared type ${value.type}`);
	}
	if (value.type === "object") {
		const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties) ? value.properties as Record<string, unknown> : undefined;
		if (value.properties !== undefined && !properties) errors.push(`${path}.properties: must be an object`);
		for (const [key, child] of Object.entries(properties ?? {})) errors.push(...validateReturnsSchema(child, `${path}.properties.${key}`, nextAncestors));
		if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string"))) errors.push(`${path}.required: must be an array of property names`);
		else for (const key of (value.required ?? []) as string[]) if (!properties || !(key in properties)) errors.push(`${path}.required: unknown property ${key}`);
	} else if (value.properties !== undefined || value.required !== undefined) errors.push(`${path}: properties/required require object type`);
	if (value.type === "array") {
		if (value.items === undefined) errors.push(`${path}.items: array items schema is required`); else errors.push(...validateReturnsSchema(value.items, `${path}.items`, nextAncestors));
	} else if (value.items !== undefined) errors.push(`${path}: items requires array type`);
	return errors;
}

export function parseCustomReturns(text: string): { schema?: ReturnsSchema; error?: string } {
	if (!text.trim()) return { error: "Custom output schema cannot be empty. Choose None to disable structured output." };
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
	const errors = validateReturnsSchema(parsed);
	return errors.length ? { error: errors.join("; ") } : { schema: parsed as ReturnsSchema };
}
