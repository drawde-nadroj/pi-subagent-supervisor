import { extractJsonBlock, validateReturns, type ReturnsSchema } from "./returns.ts";

export type ResultView = "readable" | "exact";
export type ResultPreset = "Findings" | "Review" | "Decision";

/** The single authoritative set of built-in structured-return contracts. */
export const RETURNS_PRESETS: ReadonlyArray<{ name: ResultPreset; schema: ReturnsSchema }> = [
	{ name: "Findings", schema: { type: "object", required: ["findings"], properties: { findings: { type: "array", items: { type: "object", required: ["path", "note"], properties: { path: { type: "string" }, line: { type: "number" }, note: { type: "string" } } } }, open_questions: { type: "array", items: { type: "string" } } } } },
	{ name: "Review", schema: { type: "object", required: ["verdict", "coverage", "findings"], properties: { verdict: { enum: ["approve", "fix"] }, coverage: { type: "string" }, findings: { type: "array", items: { type: "object", required: ["path", "line", "severity", "summary", "fix"], properties: { path: { type: "string" }, line: { type: "number" }, severity: { enum: ["P0", "P1", "P2", "P3"] }, summary: { type: "string" }, fix: { type: "string" } } } } } } },
	{ name: "Decision", schema: { type: "object", required: ["decision", "evidence", "risks", "recommendation"], properties: { decision: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, recommendation: { type: "string" } } } },
];

/** Small versioned presentation recipe. Parsed output is deliberately never stored. */
export type StructuredResultDescriptor =
	| { schemaVersion: 1; view: ResultView; kind: "preset"; preset: ResultPreset }
	| { schemaVersion: 1; view: ResultView; kind: "custom"; schema: ReturnsSchema };

export interface ResultSection { label: "Readable" | "Exact JSON"; text: string; format: "markdown" | "literal" }

const PRESENTATION_CAP_BYTES = 50 * 1024;

export function resolveResultView(agent: ResultView | undefined, global: ResultView): ResultView { return agent ?? global; }

export function structuredViewHint(key: string, expanded: boolean): string {
	const action = expanded ? "collapses structured result views" : "shows both structured result views";
	return key ? `${key} ${action}` : `Pi's tool-output expansion shortcut ${action}`;
}

export function isSupportedReturnsSchema(value: unknown, depth = 0, seen = new Set<object>()): value is ReturnsSchema {
	if (!value || typeof value !== "object" || Array.isArray(value) || depth > 12 || seen.has(value)) return false;
	seen.add(value);
	const schema = value as Record<string, unknown>;
	if (schema.type !== undefined && (typeof schema.type !== "string" || !["object", "array", "string", "number", "boolean"].includes(schema.type))) return false;
	if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) return false;
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.some((item) => typeof item !== "string" && typeof item !== "number"))) return false;
	if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)
		|| Object.values(schema.properties).some((child) => !isSupportedReturnsSchema(child, depth + 1, seen)))) return false;
	if (schema.items !== undefined && !isSupportedReturnsSchema(schema.items, depth + 1, seen)) return false;
	return Object.keys(schema).every((key) => ["type", "properties", "required", "items", "enum"].includes(key));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
	return value;
}

export function classifyResultPreset(schema: ReturnsSchema): ResultPreset | undefined {
	const encoded = JSON.stringify(canonical(schema));
	return RETURNS_PRESETS.find((preset) => JSON.stringify(canonical(preset.schema)) === encoded)?.name;
}

function descriptorSchema(descriptor: StructuredResultDescriptor): ReturnsSchema | undefined {
	if (descriptor.kind === "preset") return RETURNS_PRESETS.find((item) => item.name === descriptor.preset)?.schema;
	return isSupportedReturnsSchema(descriptor.schema) ? descriptor.schema : undefined;
}

/** Build metadata only after the same extraction and validation policy accepts finalText. */
export function describeStructuredResult(schema: ReturnsSchema, finalText: string, view: ResultView): StructuredResultDescriptor | undefined {
	const value = extractJsonBlock(finalText);
	if (value === undefined || validateReturns(schema, value).length > 0) return undefined;
	const exact = JSON.stringify(value, null, 2);
	if (Buffer.byteLength(exact, "utf8") > PRESENTATION_CAP_BYTES) return undefined;
	const preset = classifyResultPreset(schema);
	if (preset) return { schemaVersion: 1, view, kind: "preset", preset };
	try {
		const descriptor: StructuredResultDescriptor = { schemaVersion: 1, view, kind: "custom", schema: structuredClone(schema) };
		if (Buffer.byteLength(JSON.stringify(descriptor), "utf8") > PRESENTATION_CAP_BYTES) return undefined;
		return descriptor;
	} catch {
		return undefined;
	}
}

const COMPLETE_HINT = "Exact JSON contains the complete value.";
const MAX_DEPTH = 5;
const MAX_ITEMS = 40;
const MAX_LINES = 120;
function genericLines(value: unknown, depth = 0): string[] {
	if (depth >= MAX_DEPTH && value !== null && typeof value === "object") return [`… [depth truncated] ${COMPLETE_HINT}`];
	if (Array.isArray(value)) {
		const shown = value.slice(0, MAX_ITEMS).flatMap((item) => genericLines(item, depth + 1).map((line, index) => `${index ? "  " : "- "}${line}`));
		if (value.length > MAX_ITEMS) shown.push(`… [${value.length - MAX_ITEMS} items truncated] ${COMPLETE_HINT}`);
		return shown.length ? shown : ["(none)"];
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		return entries.length ? entries.flatMap(([key, item]) => item !== null && typeof item === "object"
			? [`${"#".repeat(Math.min(6, depth + 3))} ${key.replace(/_/g, " ")}`, ...genericLines(item, depth + 1)]
			: [`**${key.replace(/_/g, " ")}:** ${String(item)}`]) : ["(none)"];
	}
	return [value === null ? "null" : String(value)];
}
function bounded(lines: string[]): string {
	return lines.length <= MAX_LINES ? lines.join("\n") : [...lines.slice(0, MAX_LINES), `… [${lines.length - MAX_LINES} lines truncated] ${COMPLETE_HINT}`].join("\n");
}
function list(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => `- ${String(item)}`) : genericLines(value); }
function readablePreset(name: ResultPreset, value: Record<string, unknown>): string {
	if (name === "Findings") return bounded(["## Findings", ...genericLines(value.findings), "## Open questions", ...list(value.open_questions ?? [])]);
	if (name === "Review") return bounded([`## Verdict: ${String(value.verdict)}`, `**Coverage:** ${String(value.coverage)}`, "## Findings", ...genericLines(value.findings)]);
	return bounded([`## Decision: ${String(value.decision)}`, "## Evidence", ...list(value.evidence), "## Risks", ...list(value.risks), `## Recommendation\n${String(value.recommendation)}`]);
}

function projections(finalText: string, descriptor: StructuredResultDescriptor): { readable: string; exact: string } | undefined {
	if (descriptor.schemaVersion !== 1 || (descriptor.view !== "readable" && descriptor.view !== "exact")) return undefined;
	const schema = descriptorSchema(descriptor);
	if (!schema) return undefined;
	const value = extractJsonBlock(finalText);
	if (value === undefined || validateReturns(schema, value).length > 0) return undefined;
	const preset = descriptor.kind === "preset" ? descriptor.preset : undefined;
	const readable = preset && value && typeof value === "object" && !Array.isArray(value) ? readablePreset(preset, value as Record<string, unknown>) : bounded(genericLines(value));
	const exact = JSON.stringify(value, null, 2);
	if (Buffer.byteLength(exact, "utf8") > PRESENTATION_CAP_BYTES) return undefined;
	return { readable, exact };
}

/** Pure projection shared by tool and custom-message transcript surfaces. */
export function resultSections(finalText: string, descriptor: StructuredResultDescriptor | undefined, expanded: boolean): ResultSection[] {
	const projected = descriptor ? projections(finalText, descriptor) : undefined;
	if (!descriptor || !projected) return [{ label: "Exact JSON", text: finalText || "(no output)", format: "markdown" }];
	const readable: ResultSection = { label: "Readable", text: projected.readable, format: "markdown" };
	const exact: ResultSection = { label: "Exact JSON", text: projected.exact, format: "literal" };
	const preferred = descriptor.view === "readable" ? readable : exact;
	if (!expanded) return [preferred];
	const alternate = descriptor.view === "readable" ? exact : readable;
	return [preferred, alternate];
}

export function presentResultText(finalText: string, descriptor?: StructuredResultDescriptor, expanded = false): string {
	const sections = resultSections(finalText, descriptor, expanded);
	return expanded && sections.length > 1
		? sections.map(({ label, text }) => `## ${label}\n${text}`).join("\n\n")
		: sections[0]!.text;
}
