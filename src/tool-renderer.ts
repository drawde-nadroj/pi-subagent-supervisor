import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { colorize } from "./colors.ts";
import { type PersonaDescriptor } from "./persona.ts";
import { isSupportedReturnsSchema, resultSections, structuredViewHint, type StructuredResultDescriptor } from "./result-view.ts";
import { RESULT_CAP_BYTES, type CallSnapshot, type RunNodeSnapshot, type RunNodeStatus } from "./registry.ts";
import { EFFECTIVE_PROMPT_CALL_LIMIT, EFFECTIVE_PROMPT_MAX_ATTEMPTS, effectivePromptBytes, normalizeEffectivePrompt, renderEffectivePromptAttempt, type EffectivePromptCaptureEntry } from "./effective-prompt.ts";
import {
	agentContentPrefix,
	childTreePosition,
	concreteAgentActivity,
	formatAgentIdentityLine,
	type AgentTreeTheme,
	type TreePosition,
} from "./tree-presentation.ts";

export const CONTEXT_WARNING_PERCENT = 80;

/** Persisted, versioned renderer input. Every field is serializable. */
export interface SubagentToolDetailsV2 {
	schemaVersion: 2;
	revision: number;
	call: CallSnapshot;
}

/** The pre-V2 flat row shape retained solely for historical session rendering. */
export interface LegacySubagentRow {
	color?: string;
	agent?: string;
	task?: string;
	status?: "running" | "done" | "error";
	elapsedMs?: number;
	preview?: string;
	usage?: {
		input?: number;
		output?: number;
		cost?: number;
		turns?: number;
		tools?: number;
		ctx?: number | null;
	};
	log?: string[];
	children?: LegacySubagentRow[];
}

export interface LegacySubagentToolDetails {
	mode: "single" | "parallel" | "chain";
	rows: LegacySubagentRow[];
	totalCost?: number;
	tick?: number;
}

export interface SubagentToolArguments {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string }>;
	chain?: Array<{ agent: string; task: string }>;
	retry?: {
		maxRetries: number;
		retrySteps: Array<{ agent: string; task: string }>;
	};
}

/**
 * The restrained Theme surface used by this renderer. Keeping the interface
 * structural makes the pure renderer independently testable without a live TUI.
 */
export interface SubagentRendererTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface SubagentRendererState {
	/** Shared by Pi's call and result render slots for one tool execution. */
	header?: SubagentHeaderComponent;
	/** Set by registration wiring; stored details remain preference-free. */
	showCosts?: boolean;
	getShowCosts?: () => boolean;
	/** Clock read only while rendering; partial snapshots remain immutable. */
	now?: () => number;
	/** Stable coordinator subscription for this tool execution. */
	invalidate?: () => void;
	stopClock?: () => void;
	/**
	 * Pi's HTML exporter caches renderCall before renderResult. Its first call
	 * context is already complete/executing while marked partial, so that path
	 * must carry the finalized header in the exported result instead.
	 */
	exportResultOwnsHeader?: boolean;
}

export interface SubagentRendererContext {
	args: SubagentToolArguments;
	state: SubagentRendererState;
	lastComponent: Component | undefined;
	executionStarted?: boolean;
	argsComplete?: boolean;
	isPartial?: boolean;
	invalidate?: () => void;
}

export interface SubagentToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface HeaderProjection {
	/** The temporal label is useful only before a result exists. */
	showCallingLabel: boolean;
}

type RenderOptions = { expanded: boolean; isPartial: boolean; showCosts?: boolean };

function initialHeader(_args: SubagentToolArguments): HeaderProjection {
	return { showCallingLabel: true };
}

function firstAgentRole(args: SubagentToolArguments): string | undefined {
	return args.agent ?? args.tasks?.[0]?.agent ?? args.chain?.[0]?.agent;
}

function completedHeader(): HeaderProjection {
	return { showCallingLabel: false };
}

/**
 * One mutable component shared through Pi's public renderer state. Updates are
 * driven only by arguments/snapshots; render(width) is a deterministic read.
 */
export class SubagentHeaderComponent implements Component {
	private projection: HeaderProjection;
	private args: SubagentToolArguments;
	private readonly theme: SubagentRendererTheme;
	private callVisible = true;

	constructor(args: SubagentToolArguments, theme: SubagentRendererTheme) {
		this.args = args;
		this.theme = theme;
		this.projection = initialHeader(args);
	}

	updateArgs(args: SubagentToolArguments): void {
		this.args = args;
		// Do not resurrect the temporal label when Pi re-runs renderCall
		// immediately before a completed renderResult.
		if (this.projection.showCallingLabel) this.projection = initialHeader(args);
	}

	updateDetails(_details: SubagentToolDetailsV2 | LegacySubagentToolDetails): void {
		this.projection = completedHeader();
	}

	updateInvalid(isPartial: boolean): void {
		this.projection = isPartial ? initialHeader(this.args) : completedHeader();
	}

	setCallVisible(visible: boolean): void {
		this.callVisible = visible;
	}

	invalidate(): void {
		// No cached width/layout state.
	}

	render(width: number): string[] {
		return this.callVisible ? this.renderProjection(width) : [];
	}

	renderProjection(width: number): string[] {
		if (!this.projection.showCallingLabel) return [];
		const role = firstAgentRole(this.args);
		const label = role ? `found ${role}` : "calling for help...";
		return wrapTextWithAnsi(this.theme.fg("dim", label), Math.max(1, width));
	}
}

class SubagentBodyComponent implements Component {
	private result: SubagentToolResult;
	private options: RenderOptions;
	private readonly theme: SubagentRendererTheme;
	private resultHeader: SubagentHeaderComponent | undefined;
	private getShowCosts: (() => boolean) | undefined;
	private getNow: () => number;

	constructor(
		result: SubagentToolResult,
		options: RenderOptions,
		theme: SubagentRendererTheme,
		resultHeader?: SubagentHeaderComponent,
		getShowCosts?: () => boolean,
		getNow: () => number = Date.now,
	) {
		this.result = result;
		this.options = options;
		this.theme = theme;
		this.resultHeader = resultHeader;
		this.getShowCosts = getShowCosts;
		this.getNow = getNow;
	}

	update(result: SubagentToolResult, options: RenderOptions, resultHeader?: SubagentHeaderComponent, getShowCosts?: () => boolean, getNow: () => number = Date.now): void {
		this.result = result;
		this.options = options;
		this.resultHeader = resultHeader;
		this.getShowCosts = getShowCosts;
		this.getNow = getNow;
	}

	invalidate(): void {
		// No cached width/layout state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const header = this.resultHeader?.renderProjection(safeWidth) ?? [];
		const details = normalizeV2Details(this.result.details);
		const showCosts = this.getShowCosts?.() ?? this.options.showCosts ?? false;
		if (details) {
			const includeAnswers = !this.options.isPartial;
			const call = this.options.isPartial ? projectActiveDurations(details.call, this.getNow()) : details.call;
			const body = this.options.expanded
				? renderExpandedCall(call, this.theme, safeWidth, showCosts, includeAnswers)
				: renderCompactCall({ ...details, call }, this.theme, safeWidth, showCosts, includeAnswers);
			if (body.length > 0) return [...header, ...body];
			const fallback = firstText(this.result) || "No subagents were started.";
			return [...header, ...wrapStyled(fallback, this.theme, "muted", safeWidth)];
		}
		if (isLegacyDetails(this.result.details)) {
			return [...header, ...renderLegacyCall(this.result.details, this.result, { ...this.options, showCosts }, this.theme, safeWidth)];
		}
		const fallback = firstText(this.result) || "No subagent details available.";
		return [...header, ...wrapStyled(fallback, this.theme, "muted", safeWidth)];
	}
}

export function renderSubagentCall(
	args: SubagentToolArguments,
	theme: SubagentRendererTheme,
	context: SubagentRendererContext,
): Component {
	const firstCallRender = context.state.header === undefined;
	if (
		firstCallRender
		&& context.executionStarted === true
		&& context.argsComplete === true
		&& context.isPartial === true
	) {
		context.state.exportResultOwnsHeader = true;
	}
	const header = context.lastComponent instanceof SubagentHeaderComponent
		? context.lastComponent
		: context.state.header ?? new SubagentHeaderComponent(args, theme);
	header.updateArgs(args);
	header.setCallVisible(context.state.exportResultOwnsHeader !== true);
	context.state.header = header;
	return header;
}

export function renderSubagentResult(
	result: SubagentToolResult,
	options: RenderOptions,
	theme: SubagentRendererTheme,
	context: SubagentRendererContext,
): Component {
	const normalizedV2 = normalizeV2Details(result.details);
	const legacy = isLegacyDetails(result.details) ? result.details : undefined;
	// Usually Pi renders the call slot first. Keep invalid/stored result-only paths
	// useful too (including exporters that skip that slot).
	const resultOwnsHeader = context.state.exportResultOwnsHeader === true || context.state.header === undefined;
	const header = context.state.header ?? new SubagentHeaderComponent(context.args, theme);
	context.state.header = header;
	const invalidStoredDetails = result.details !== undefined && normalizedV2 === undefined && legacy === undefined;
	const safeResult: SubagentToolResult = invalidStoredDetails
		? {
			content: [{ type: "text", text: "Invalid stored subagent details." }],
			details: undefined,
		}
		: { ...result, details: normalizedV2 ?? legacy };
	if (normalizedV2 || legacy) {
		header.updateDetails(normalizedV2 ?? legacy!);
	} else {
		header.updateInvalid(options.isPartial);
	}
	const renderOptions = { ...options, showCosts: context.state.showCosts ?? false };
	const body = context.lastComponent instanceof SubagentBodyComponent
		? context.lastComponent
		: new SubagentBodyComponent(
			safeResult,
			renderOptions,
			theme,
			resultOwnsHeader ? header : undefined,
			context.state.getShowCosts,
			context.state.now,
		);
	body.update(
		safeResult,
		renderOptions,
		resultOwnsHeader ? header : undefined,
		context.state.getShowCosts,
		context.state.now,
	);
	return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const V2_TOOL_LOG_CAP = 200;
const RUN_STATUSES = new Set<RunNodeStatus>(["dormant", "active", "success", "error", "aborted"]);
const ACTIVITY_TYPES = new Set(["planned", "started", "status", "tool", "text", "usage", "finished"]);

function nonnegativeNumber(value: unknown, integer = false): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	if (integer && !Number.isInteger(value)) return undefined;
	return value;
}

function optionalNumber(value: unknown, integer = false): number | undefined {
	return value === undefined ? undefined : nonnegativeNumber(value, integer);
}

function optionalString(value: unknown): string | undefined {
	return value === undefined || typeof value === "string" ? value : undefined;
}

function normalizeUsage(value: unknown): RunNodeSnapshot["usage"] | undefined {
	if (!isRecord(value)) return undefined;
	const input = nonnegativeNumber(value.input, true);
	const output = nonnegativeNumber(value.output, true);
	const cacheRead = nonnegativeNumber(value.cacheRead, true);
	const cacheWrite = nonnegativeNumber(value.cacheWrite, true);
	const cost = nonnegativeNumber(value.cost);
	const turns = nonnegativeNumber(value.turns, true);
	const toolCalls = nonnegativeNumber(value.toolCalls, true);
	const contextTokens = nonnegativeNumber(value.contextTokens, true);
	if (
		input === undefined || output === undefined || cacheRead === undefined
		|| cacheWrite === undefined || cost === undefined || turns === undefined
		|| toolCalls === undefined || contextTokens === undefined
	) return undefined;
	return { input, output, cacheRead, cacheWrite, cost, turns, toolCalls, contextTokens };
}

function normalizeActivity(value: unknown): RunNodeSnapshot["activity"] | undefined {
	if (!isRecord(value) || typeof value.type !== "string" || !ACTIVITY_TYPES.has(value.type)) return undefined;
	const at = nonnegativeNumber(value.at);
	const text = optionalString(value.text);
	const tool = optionalString(value.tool);
	if (
		at === undefined
		|| (value.text !== undefined && text === undefined)
		|| (value.tool !== undefined && tool === undefined)
	) return undefined;
	return {
		type: value.type as RunNodeSnapshot["activity"]["type"],
		at,
		text,
		tool,
	};
}

function normalizeStructuredResult(value: unknown): StructuredResultDescriptor | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || (value.view !== "readable" && value.view !== "exact")) return undefined;
	if (value.kind === "preset" && (value.preset === "Findings" || value.preset === "Review" || value.preset === "Decision"))
		return { schemaVersion: 1, view: value.view, kind: "preset", preset: value.preset };
	if (value.kind !== "custom" || !isSupportedReturnsSchema(value.schema)) return undefined;
	try {
		const descriptor: StructuredResultDescriptor = { schemaVersion: 1, view: value.view, kind: "custom", schema: structuredClone(value.schema) };
		if (Buffer.byteLength(JSON.stringify(descriptor), "utf8") > RESULT_CAP_BYTES) return undefined;
		return descriptor;
	} catch { return undefined; }
}

function normalizeNode(value: unknown, seen: Set<object>, promptBudget: { count: number; bytes: number }): RunNodeSnapshot | undefined {
	if (!isRecord(value) || seen.has(value)) return undefined;
	seen.add(value);

	const id = nonnegativeNumber(value.id, true);
	const callId = nonnegativeNumber(value.callId, true);
	const parentId = optionalNumber(value.parentId, true);
	const plannedAt = nonnegativeNumber(value.plannedAt);
	const startedAt = optionalNumber(value.startedAt);
	const finishedAt = optionalNumber(value.finishedAt);
	const durationMs = nonnegativeNumber(value.durationMs);
	const contextPercent = value.contextPercent === null ? null : nonnegativeNumber(value.contextPercent);
	const ownCost = nonnegativeNumber(value.ownCost);
	const subtreeCost = nonnegativeNumber(value.subtreeCost);
	const usage = normalizeUsage(value.usage);
	const activity = normalizeActivity(value.activity);
	const model = optionalString(value.model);
	const finalText = optionalString(value.finalText);
	const error = optionalString(value.error);
	const structuredResult = value.structuredResult === undefined ? undefined : normalizeStructuredResult(value.structuredResult);
	let effectivePrompts: readonly Readonly<EffectivePromptCaptureEntry>[] | undefined;
	if (value.effectivePrompts !== undefined) {
		const countBefore = promptBudget.count;
		const bytesBefore = promptBudget.bytes;
		try {
			if (!Array.isArray(value.effectivePrompts) || value.effectivePrompts.length > EFFECTIVE_PROMPT_MAX_ATTEMPTS) throw new Error("invalid prompt descriptor list");
			effectivePrompts = Object.freeze(value.effectivePrompts.map((prompt: unknown) => {
				const normalized = normalizeEffectivePrompt(prompt);
				if (!normalized) throw new Error("invalid prompt descriptor");
				const size = effectivePromptBytes(normalized);
				if (promptBudget.count + 1 > EFFECTIVE_PROMPT_MAX_ATTEMPTS || promptBudget.bytes + size > EFFECTIVE_PROMPT_CALL_LIMIT) throw new Error("prompt call limit exceeded");
				promptBudget.count += 1;
				promptBudget.bytes += size;
				return normalized;
			}));
		} catch {
			promptBudget.count = countBefore;
			promptBudget.bytes = bytesBefore;
			effectivePrompts = undefined;
		}
	}

	if (
		id === undefined || callId === undefined
		|| (value.parentId !== undefined && parentId === undefined)
		|| typeof value.role !== "string"
		|| !isRecord(value.persona) || typeof value.persona.base !== "string"
		|| nonnegativeNumber(value.persona.friendDepth, true) === undefined
		|| typeof value.color !== "string" || typeof value.task !== "string"
		|| typeof value.status !== "string" || !RUN_STATUSES.has(value.status as RunNodeStatus)
		|| plannedAt === undefined
		|| (value.startedAt !== undefined && startedAt === undefined)
		|| (value.finishedAt !== undefined && finishedAt === undefined)
		|| durationMs === undefined || usage === undefined
		|| (value.model !== undefined && model === undefined)
		|| (value.contextPercent !== null && contextPercent === undefined)
		|| activity === undefined || !Array.isArray(value.toolLog)
		|| value.toolLog.length > V2_TOOL_LOG_CAP || !value.toolLog.every((entry) => typeof entry === "string")
		|| (value.finalText !== undefined && finalText === undefined)
		|| (value.error !== undefined && error === undefined)
		|| (finalText !== undefined && Buffer.byteLength(finalText, "utf8") > RESULT_CAP_BYTES)
		|| (error !== undefined && Buffer.byteLength(error, "utf8") > RESULT_CAP_BYTES)
		|| ownCost === undefined || subtreeCost === undefined || !Array.isArray(value.children)
	) return undefined;

	const children: RunNodeSnapshot[] = [];
	for (const childValue of value.children) {
		const child = normalizeNode(childValue, seen, promptBudget);
		if (!child) return undefined;
		children.push(child);
	}

	return {
		id,
		callId,
		parentId,
		role: value.role,
		persona: {
			base: value.persona.base,
			friendDepth: value.persona.friendDepth as number,
		},
		color: value.color,
		task: value.task,
		status: value.status as RunNodeStatus,
		plannedAt,
		startedAt,
		finishedAt,
		durationMs,
		usage,
		model,
		contextPercent: contextPercent ?? null,
		activity,
		toolLog: [...value.toolLog],
		finalText,
		structuredResult,
		error,
		ownCost,
		subtreeCost,
		children,
		...(effectivePrompts === undefined ? {} : { effectivePrompts }),
	};
}

/**
 * Validate and detach persisted V2 data before a component keeps it for a
 * deferred render. A malformed field anywhere in the tree rejects the whole
 * snapshot, so render(width) never discovers corruption by throwing.
 */
export function normalizeV2Details(value: unknown): SubagentToolDetailsV2 | undefined {
	if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.call)) return undefined;
	const call = value.call;
	const revision = nonnegativeNumber(value.revision, true);
	const callRevision = nonnegativeNumber(call.revision, true);
	const id = nonnegativeNumber(call.id, true);
	const createdAt = nonnegativeNumber(call.createdAt);
	const finishedAt = optionalNumber(call.finishedAt);
	const durationMs = nonnegativeNumber(call.durationMs);
	const totalCost = nonnegativeNumber(call.totalCost);
	const retryConfigured = optionalNumber(call.retryConfigured, true);
	const launchSurface = call.launchSurface === undefined
		? "foreground"
		: call.launchSurface === "foreground" || call.launchSurface === "background"
			? call.launchSurface
			: undefined;
	if (
		revision === undefined || callRevision === undefined || revision !== callRevision
		|| id === undefined
		|| (call.mode !== "single" && call.mode !== "parallel" && call.mode !== "chain")
		|| createdAt === undefined
		|| (call.finishedAt !== undefined && finishedAt === undefined)
		|| durationMs === undefined || !isRecord(call.counts)
		|| totalCost === undefined || !Array.isArray(call.roots)
		|| (call.retryConfigured !== undefined && retryConfigured === undefined)
		|| launchSurface === undefined
	) return undefined;

	const callCounts = call.counts as Record<string, unknown>;
	const countKeys = ["total", "dormant", "active", "finished", "failed"] as const;
	const counts = Object.fromEntries(
		countKeys.map((key) => [key, nonnegativeNumber(callCounts[key], true)]),
	) as Record<(typeof countKeys)[number], number | undefined>;
	if (countKeys.some((key) => counts[key] === undefined)) return undefined;

	const seen = new Set<object>();
	const promptBudget = { count: 0, bytes: 0 };
	const roots: RunNodeSnapshot[] = [];
	for (const rootValue of call.roots) {
		const root = normalizeNode(rootValue, seen, promptBudget);
		if (!root) return undefined;
		roots.push(root);
	}
	// Stored/live partial details are untrusted. Prompt text becomes visible only
	// after the call has one terminal finishedAt value.
	if (finishedAt === undefined) {
		const redact = (node: RunNodeSnapshot): void => {
			delete node.effectivePrompts;
			for (const child of node.children) redact(child);
		};
		for (const root of roots) redact(root);
	}

	return {
		schemaVersion: 2,
		revision,
		call: {
			id,
			mode: call.mode,
			launchSurface,
			revision: callRevision,
			createdAt,
			finishedAt,
			durationMs,
			counts: {
				total: counts.total!,
				dormant: counts.dormant!,
				active: counts.active!,
				finished: counts.finished!,
				failed: counts.failed!,
			},
			totalCost,
			roots,
			retryConfigured,
		},
	};
}

export function isV2Details(value: unknown): value is SubagentToolDetailsV2 {
	return normalizeV2Details(value) !== undefined;
}

export function isLegacyDetails(value: unknown): value is LegacySubagentToolDetails {
	if (!isRecord(value) || "schemaVersion" in value || !Array.isArray(value.rows)) return false;
	return value.mode === "single" || value.mode === "parallel" || value.mode === "chain";
}

function firstText(result: SubagentToolResult): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function statusColor(status: RunNodeStatus): string {
	return status === "error" || status === "aborted" ? "error" : "muted";
}

function oneLine(text: string | undefined, fallback: string): string {
	const line = text?.split("\n").find((candidate) => candidate.trim());
	return line?.trim() || fallback;
}

function rendererTreeTheme(theme: SubagentRendererTheme): AgentTreeTheme {
	return { muted: (text) => theme.fg("muted", text) };
}

/** Project active durations without mutating the persisted partial snapshot. */
function projectActiveDurations(call: CallSnapshot, now: number): CallSnapshot {
	const projectNode = (node: RunNodeSnapshot): RunNodeSnapshot => ({
		...node,
		durationMs: node.status === "active" && node.startedAt !== undefined
			? Math.max(0, now - node.startedAt)
			: node.durationMs,
		children: node.children.map(projectNode),
	});
	return { ...call, roots: call.roots.map(projectNode) };
}

function compactDetails(node: RunNodeSnapshot, showCosts: boolean): string[] {
	return [
		...(node.contextPercent !== null && node.contextPercent >= CONTEXT_WARNING_PERCENT
			? [`context ${Math.round(node.contextPercent)}%`]
			: []),
		...(showCosts ? [`$${node.ownCost.toFixed(4)}`] : []),
	];
}

function boundedContentPrefix(prefix: string, width: number, optionalIndent = 0): string {
	const budget = Math.max(0, width - Math.min(8, width));
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth > budget) return " ".repeat(budget);
	return `${prefix}${" ".repeat(Math.min(optionalIndent, budget - prefixWidth))}`;
}

/** Transcript prompts are authoritative content, not status-line previews. */
function renderAgentPrompt(
	node: RunNodeSnapshot,
	position: TreePosition,
	hasChildren: boolean,
	theme: SubagentRendererTheme,
	width: number,
): string[] {
	const prefix = boundedContentPrefix(agentContentPrefix(node, position, hasChildren), width);
	const task = node.task || "(no assigned task)";
	const activity = concreteAgentActivity(node);
	return wrapStyled(activity ? `${activity} · ${task}` : task, theme, "muted", width, prefix);
}

function renderCompactNode(
	node: RunNodeSnapshot,
	position: TreePosition,
	theme: SubagentRendererTheme,
	width: number,
	showCosts: boolean,
	includeAnswers = false,
): string[] {
	const treeTheme = rendererTreeTheme(theme);
	const lines = [
		formatAgentIdentityLine(node, position, treeTheme, width, {
			showTokens: true,
			optionalDetails: compactDetails(node, showCosts),
			showActiveDuration: true,
		}),
		...renderAgentPrompt(node, position, node.children.length > 0, theme, width),
	];
	for (const [index, child] of node.children.entries()) {
		lines.push(...renderCompactNode(
			child,
			childTreePosition(position, node, index === node.children.length - 1),
			theme,
			width,
			showCosts,
			includeAnswers,
		));
	}
	if (includeAnswers && node.status !== "active" && node.status !== "dormant") {
		lines.push(...renderTerminalAnswer(node, position, theme, width));
	}
	return lines;
}

function terminalSections(node: RunNodeSnapshot, expanded = false): Array<{ label: string; text: string; format: "markdown" | "literal" }> {
	const error = node.error?.trim();
	const returned = node.finalText?.trim();
	const sections: Array<{ label: string; text: string; format: "markdown" | "literal" }> = [];
	if (error) sections.push({ label: "Error", text: error, format: "markdown" });
	if (returned && returned !== error) {
		const projected = resultSections(returned, node.structuredResult, expanded);
		const hasAlternate = resultSections(returned, node.structuredResult, true).length > 1;
		sections.push(...projected.map(({ label, text, format }) => ({ label: projected.length > 1 ? label : "Returned", text, format })));
		if (hasAlternate) sections.push({ label: "View", text: structuredViewHint(keyText("app.tools.expand"), expanded), format: "literal" });
	}
	if (sections.length === 0) sections.push({ label: "Returned", text: "(no output)", format: "literal" });
	return sections;
}

function renderTerminalAnswer(
	node: RunNodeSnapshot,
	position: TreePosition,
	theme: SubagentRendererTheme,
	width: number,
): string[] {
	// Keep open ancestor rails visible through this return so a later sibling's
	// connector does not appear after a broken vertical line. The final three
	// spaces belong to the current node, not its ancestors.
	const ancestorRails = agentContentPrefix(node, position, false).slice(0, -3);
	const prefix = (indent: number): string => boundedContentPrefix(ancestorRails, width, indent);
	return terminalSections(node).flatMap(({ label, text, format }) => [
		...wrapStyled(label, theme, label === "Error" ? "error" : "muted", width, prefix(2)),
		...(format === "literal" ? wrapStyled(text, theme, "text", width, prefix(4)) : renderMarkdown(text, prefix(4), width)),
	]);
}

function renderCompactCall(details: SubagentToolDetailsV2, theme: SubagentRendererTheme, width: number, showCosts: boolean, includeAnswers = true): string[] {
	if (details.call.roots.length === 0) return [];
	const lines: string[] = [];
	details.call.roots.forEach((root, index) => {
		if (index > 0) lines.push("");
		lines.push(...renderCompactNode(
			root,
			{ ancestors: [], last: index === details.call.roots.length - 1 },
			theme,
			width,
			showCosts,
			includeAnswers,
		));
	});
	return lines;
}

function wrapStyled(text: string, theme: SubagentRendererTheme, color: string, width: number, prefix = ""): string[] {
	const available = Math.max(1, width - visibleWidth(prefix));
	return text.split("\n").flatMap((line) =>
		wrapTextWithAnsi(theme.fg(color, line || " "), available).map((wrapped) =>
			truncateToWidth(prefix + wrapped, width)));
}

function renderMarkdown(text: string, prefix: string, width: number): string[] {
	const available = Math.max(1, width - visibleWidth(prefix));
	const markdown = new Markdown(text || "(no output)", 0, 0, getMarkdownTheme());
	return markdown.render(available).map((line) => truncateToWidth(prefix + line, width));
}

function expandedMetrics(node: RunNodeSnapshot, showCosts: boolean, hasVisibleChildren: boolean): string {
	const usage = node.usage;
	const context = node.contextPercent === null ? "n/a" : `${Math.round(node.contextPercent)}%`;
	return [
		`turns ${usage.turns}`,
		`tools ${usage.toolCalls}`,
		`cache read ${usage.cacheRead}`,
		`cache write ${usage.cacheWrite}`,
		...(node.contextPercent === null || node.contextPercent < CONTEXT_WARNING_PERCENT ? [`context ${context}`] : []),
		`model ${node.model ?? "unknown"}`,
		...(showCosts && hasVisibleChildren && Math.abs(node.subtreeCost - node.ownCost) > Number.EPSILON
			? [`subtree total $${node.subtreeCost.toFixed(4)}`]
			: []),
	].join(" · ");
}

function renderExpandedNode(
	node: RunNodeSnapshot,
	position: TreePosition,
	theme: SubagentRendererTheme,
	width: number,
	includeAnswer: boolean,
	showCosts: boolean,
): string[] {
	const treeTheme = rendererTreeTheme(theme);
	const lines = [
		formatAgentIdentityLine(node, position, treeTheme, width, {
			showTokens: true,
			optionalDetails: compactDetails(node, showCosts),
			showActiveDuration: true,
		}),
		...renderAgentPrompt(node, position, true, theme, width),
	];
	// Expanded content continues after every descendant, so keep both the
	// current node's rail and every ancestor rail open for the full block.
	const contentRailPrefix = agentContentPrefix(node, position, true);
	const section = (label: string): string =>
		truncateToWidth(`${boundedContentPrefix(contentRailPrefix, width)}${theme.fg("muted", theme.bold(label))}`, width);
	const contentPrefix = (): string => boundedContentPrefix(contentRailPrefix, width, 3);

	const toolLog = node.toolLog.filter((entry) => !/^\s*subagent\b/i.test(entry));
	if (toolLog.length > 0) {
		lines.push(section("Activity"));
		toolLog.forEach((entry, index) => {
			lines.push(...wrapStyled(`${index + 1}. ${entry}`, theme, "dim", width, contentPrefix()));
		});
	}

	if (node.children.length > 0) {
		lines.push(section("Delegated"));
		node.children.forEach((child) => {
			lines.push(...renderExpandedNode(
				child,
				// Returned/Details follow the descendants, so no child is the
				// terminal branch of an expanded node.
				childTreePosition(position, node, false),
				theme,
				width,
				includeAnswer,
				showCosts,
			));
		});
	}

	if (includeAnswer && node.status !== "active" && node.status !== "dormant") {
		for (const { label, text, format } of terminalSections(node, true)) {
			lines.push(section(label));
			lines.push(...(format === "literal" ? wrapStyled(text, theme, "text", width, contentPrefix()) : renderMarkdown(text, contentPrefix(), width)));
		}
		if ((node.effectivePrompts?.length ?? 0) > 0) {
			lines.push(section("Launch input"));
			for (const prompt of node.effectivePrompts!) lines.push(...wrapStyled(renderEffectivePromptAttempt(prompt), theme, "text", width, contentPrefix()));
		}
	}
	lines.push(section("Details"));
	lines.push(...wrapStyled(expandedMetrics(node, showCosts, node.children.length > 0), theme, "dim", width, contentPrefix()));
	return lines;
}

function renderExpandedCall(call: CallSnapshot, theme: SubagentRendererTheme, width: number, showCosts: boolean, includeAnswers = true): string[] {
	if (call.roots.length === 0) return [];
	const lines: string[] = [];
	call.roots.forEach((root, index) => {
		if (index > 0) lines.push("");
		lines.push(...renderExpandedNode(
			root,
			{ ancestors: [], last: index === call.roots.length - 1 },
			theme,
			width,
			includeAnswers,
			showCosts,
		));
	});
	return lines;
}

function legacyStatus(row: LegacySubagentRow): RunNodeStatus {
	return row.status === "running" ? "active" : row.status === "error" ? "error" : "success";
}

function legacyPersona(row: LegacySubagentRow): PersonaDescriptor {
	return { base: row.agent?.trim() || "unknown agent", friendDepth: 0 };
}

function legacyNode(row: LegacySubagentRow, parentId?: number): RunNodeSnapshot {
	const status = legacyStatus(row);
	const ownCost = row.usage?.cost ?? 0;
	const children = (row.children ?? []).map((child) => legacyNode(child, 0));
	return {
		id: 0,
		callId: 0,
		parentId,
		role: row.agent ?? "",
		persona: legacyPersona(row),
		color: row.color ?? "gray",
		task: row.task ?? "",
		status,
		plannedAt: 0,
		startedAt: 0,
		finishedAt: status === "active" ? undefined : row.elapsedMs ?? 0,
		durationMs: row.elapsedMs ?? 0,
		usage: {
			input: row.usage?.input ?? 0,
			output: row.usage?.output ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: row.usage?.cost ?? 0,
			turns: row.usage?.turns ?? 0,
			toolCalls: row.usage?.tools ?? 0,
			contextTokens: 0,
		},
		contextPercent: row.usage?.ctx ?? null,
		activity: { type: status === "active" ? "tool" : "finished", at: 0, text: row.preview },
		toolLog: [...(row.log ?? [])],
		finalText: status === "success" ? row.preview : undefined,
		error: status === "error" ? row.preview : undefined,
		ownCost,
		subtreeCost: ownCost + children.reduce((sum, child) => sum + child.subtreeCost, 0),
		children,
	};
}

function renderLegacyCall(
	details: LegacySubagentToolDetails,
	result: SubagentToolResult,
	options: RenderOptions,
	theme: SubagentRendererTheme,
	width: number,
): string[] {
	if (details.rows.length === 0) {
		return wrapStyled(firstText(result) || "No historical subagent runs.", theme, "muted", width);
	}
	const roots = details.rows.map((row) => legacyNode(row));
	const lines = roots.flatMap((root, index) => renderCompactNode(
		root,
		{ ancestors: [], last: index === roots.length - 1 },
		theme,
		width,
		options.showCosts ?? false,
	));
	if (options.expanded && firstText(result)) {
		lines.push(...renderMarkdown(firstText(result), "", width));
	}
	return lines;
}
