export const EFFECTIVE_PROMPT_FIELD_LIMIT = 16 * 1024;
export const EFFECTIVE_PROMPT_ATTEMPT_LIMIT = 24 * 1024;
export const EFFECTIVE_PROMPT_CALL_LIMIT = 96 * 1024;
export const EFFECTIVE_PROMPT_MAX_ATTEMPTS = 64;
export const EFFECTIVE_PROMPT_SCHEMA_VERSION = 1 as const;
const METADATA_STRING_LIMIT = 4096;
const METADATA_ARRAY_LIMIT = 256;

export type PromptOmissionReason = "field limit exceeded" | "metadata limit exceeded" | "active tool count limit exceeded" | "attempt limit exceeded" | "aggregate call limit exceeded";
export interface PromptOmission {
	readonly omitted: true;
	readonly originalBytes: number;
	readonly limitBytes: number;
	readonly reason: PromptOmissionReason;
}
export type InspectedText = string | PromptOmission;
export interface EffectivePromptAttempt {
	readonly schemaVersion: typeof EFFECTIVE_PROMPT_SCHEMA_VERSION;
	readonly kind: "attempt";
	readonly order: number;
	readonly systemPrompt: InspectedText;
	readonly firstUserMessage: InspectedText;
	readonly provider: InspectedText;
	readonly model: InspectedText;
	readonly thinkingLevel?: InspectedText;
	readonly activeTools: readonly InspectedText[];
	readonly cwd: InspectedText;
}
export interface EffectivePromptAggregateOmission {
	readonly schemaVersion: typeof EFFECTIVE_PROMPT_SCHEMA_VERSION;
	readonly kind: "aggregate_omission";
	readonly reason: "capture entry limit exceeded";
	readonly omittedAttemptCount: number;
	readonly firstOrder: number;
	readonly lastOrder: number;
}
export type EffectivePromptCaptureEntry = EffectivePromptAttempt | EffectivePromptAggregateOmission;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const omission = (text: string, limitBytes: number, reason: PromptOmissionReason): PromptOmission => Object.freeze({ omitted: true, originalBytes: Buffer.byteLength(text, "utf8"), limitBytes, reason });
function normalizeOmission(value: unknown): PromptOmission | undefined {
	if (!value || typeof value !== "object" || (value as any).omitted !== true) return undefined;
	const { originalBytes, limitBytes, reason } = value as any;
	if (!Number.isSafeInteger(originalBytes) || originalBytes < 0) return undefined;
	if (!Number.isSafeInteger(limitBytes) || limitBytes < 0 || limitBytes > EFFECTIVE_PROMPT_CALL_LIMIT) return undefined;
	if (!["field limit exceeded", "metadata limit exceeded", "active tool count limit exceeded", "attempt limit exceeded", "aggregate call limit exceeded"].includes(reason)) return undefined;
	return Object.freeze({ omitted: true, originalBytes, limitBytes, reason });
}
function normalizedField(value: unknown, limit: number, reason: PromptOmissionReason, activeTool = false): InspectedText | undefined {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= limit ? value : omission(value, limit, reason);
	const normalized = normalizeOmission(value);
	if (!normalized) return undefined;
	const expected = normalized.reason === reason && normalized.limitBytes === limit;
	const attemptFallback = normalized.reason === "attempt limit exceeded" && normalized.limitBytes === EFFECTIVE_PROMPT_ATTEMPT_LIMIT;
	const toolCount = activeTool && normalized.reason === "active tool count limit exceeded" && normalized.limitBytes === METADATA_ARRAY_LIMIT;
	const aggregateFallback = normalized.reason === "aggregate call limit exceeded" && normalized.limitBytes === EFFECTIVE_PROMPT_CALL_LIMIT;
	return expected || attemptFallback || toolCount || aggregateFallback ? normalized : undefined;
}
function runtimeField(value: unknown, limit: number, reason: PromptOmissionReason): InspectedText {
	const text = typeof value === "string" ? value : String(value ?? "");
	return Buffer.byteLength(text, "utf8") <= limit ? text : omission(text, limit, reason);
}

function freezeAttempt(value: Omit<EffectivePromptAttempt, "schemaVersion" | "kind">): Readonly<EffectivePromptAttempt> {
	return Object.freeze({ schemaVersion: EFFECTIVE_PROMPT_SCHEMA_VERSION, kind: "attempt", ...value, activeTools: Object.freeze([...value.activeTools]) });
}
function fallbackAttempt(input: { order: number; systemPrompt: unknown; firstUserMessage: unknown; provider: unknown; model: unknown; thinkingLevel?: unknown; activeTools: unknown; cwd: unknown }): Readonly<EffectivePromptAttempt> {
	const omit = (value: unknown) => omission(typeof value === "string" ? value : String(value ?? ""), EFFECTIVE_PROMPT_ATTEMPT_LIMIT, "attempt limit exceeded");
	return freezeAttempt({
		order: input.order,
		systemPrompt: omit(input.systemPrompt), firstUserMessage: omit(input.firstUserMessage),
		provider: omit(input.provider), model: omit(input.model),
		...(input.thinkingLevel == null ? {} : { thinkingLevel: omit(input.thinkingLevel) }),
		activeTools: Object.freeze(Array.isArray(input.activeTools) ? [omit(JSON.stringify(input.activeTools))] : []),
		cwd: omit(input.cwd),
	});
}

/** Convert runtime values into a bounded, JSON-safe immutable descriptor. */
export function inspectEffectivePrompt(input: { order: number; systemPrompt: unknown; firstUserMessage: unknown; provider: unknown; model: unknown; thinkingLevel?: unknown; activeTools: unknown; cwd: unknown }): Readonly<EffectivePromptAttempt> {
	const order = Number.isSafeInteger(input.order) && input.order > 0 ? input.order : 1;
	let descriptor = freezeAttempt({
		order,
		systemPrompt: runtimeField(input.systemPrompt, EFFECTIVE_PROMPT_FIELD_LIMIT, "field limit exceeded"),
		firstUserMessage: runtimeField(input.firstUserMessage, EFFECTIVE_PROMPT_FIELD_LIMIT, "field limit exceeded"),
		provider: runtimeField(input.provider, METADATA_STRING_LIMIT, "metadata limit exceeded"),
		model: runtimeField(input.model, METADATA_STRING_LIMIT, "metadata limit exceeded"),
		...(input.thinkingLevel == null ? {} : { thinkingLevel: runtimeField(input.thinkingLevel, METADATA_STRING_LIMIT, "metadata limit exceeded") }),
		activeTools: Object.freeze(Array.isArray(input.activeTools) ? (input.activeTools.length <= METADATA_ARRAY_LIMIT ? input.activeTools.map((v) => runtimeField(v, METADATA_STRING_LIMIT, "metadata limit exceeded")) : [...input.activeTools.slice(0, METADATA_ARRAY_LIMIT - 1).map((v) => runtimeField(v, METADATA_STRING_LIMIT, "metadata limit exceeded")), omission(JSON.stringify(input.activeTools), METADATA_ARRAY_LIMIT, "active tool count limit exceeded")]) : []),
		cwd: runtimeField(input.cwd, METADATA_STRING_LIMIT, "metadata limit exceeded"),
	});
	if (bytes(descriptor) > EFFECTIVE_PROMPT_ATTEMPT_LIMIT) descriptor = freezeAttempt({ ...descriptor, activeTools: [omission(JSON.stringify(descriptor.activeTools), EFFECTIVE_PROMPT_ATTEMPT_LIMIT, "attempt limit exceeded")] });
	if (bytes(descriptor) > EFFECTIVE_PROMPT_ATTEMPT_LIMIT) descriptor = fallbackAttempt({ ...input, order });
	return descriptor;
}

/** Defensive boundary for persisted transcript descriptors. */
export function normalizeEffectivePrompt(value: unknown): Readonly<EffectivePromptCaptureEntry> | undefined {
	if (!value || typeof value !== "object" || (value as any).schemaVersion !== EFFECTIVE_PROMPT_SCHEMA_VERSION) return undefined;
	const input = value as any;
	if (input.kind === "aggregate_omission") {
		if (input.reason !== "capture entry limit exceeded" || !Number.isSafeInteger(input.omittedAttemptCount) || input.omittedAttemptCount < 1 || !Number.isSafeInteger(input.firstOrder) || input.firstOrder < 1 || !Number.isSafeInteger(input.lastOrder) || input.lastOrder < input.firstOrder || !Number.isSafeInteger(input.lastOrder - input.firstOrder + 1) || input.omittedAttemptCount !== input.lastOrder - input.firstOrder + 1) return undefined;
		return Object.freeze({ schemaVersion: EFFECTIVE_PROMPT_SCHEMA_VERSION, kind: "aggregate_omission", reason: input.reason, omittedAttemptCount: input.omittedAttemptCount, firstOrder: input.firstOrder, lastOrder: input.lastOrder });
	}
	if (input.kind !== "attempt" || !Number.isSafeInteger(input.order) || input.order < 1 || !Array.isArray(input.activeTools) || input.activeTools.length > METADATA_ARRAY_LIMIT) return undefined;
	const systemPrompt = normalizedField(input.systemPrompt, EFFECTIVE_PROMPT_FIELD_LIMIT, "field limit exceeded");
	const firstUserMessage = normalizedField(input.firstUserMessage, EFFECTIVE_PROMPT_FIELD_LIMIT, "field limit exceeded");
	const provider = normalizedField(input.provider, METADATA_STRING_LIMIT, "metadata limit exceeded");
	const model = normalizedField(input.model, METADATA_STRING_LIMIT, "metadata limit exceeded");
	const cwd = normalizedField(input.cwd, METADATA_STRING_LIMIT, "metadata limit exceeded");
	const thinkingLevel = input.thinkingLevel === undefined ? undefined : normalizedField(input.thinkingLevel, METADATA_STRING_LIMIT, "metadata limit exceeded");
	const activeTools = input.activeTools.map((field: unknown) => normalizedField(field, METADATA_STRING_LIMIT, "metadata limit exceeded", true));
	if ([systemPrompt, firstUserMessage, provider, model, cwd, ...activeTools, ...(input.thinkingLevel === undefined ? [] : [thinkingLevel])].some((field) => field === undefined)) return undefined;
	const result = freezeAttempt({ order: input.order, systemPrompt: systemPrompt!, firstUserMessage: firstUserMessage!, provider: provider!, model: model!, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), activeTools: activeTools as InspectedText[], cwd: cwd! });
	return bytes(result) <= EFFECTIVE_PROMPT_ATTEMPT_LIMIT ? result : undefined;
}

export function effectivePromptBytes(value: EffectivePromptCaptureEntry): number { return bytes(value); }
export function omitAttemptTextForAggregate(value: EffectivePromptAttempt): Readonly<EffectivePromptAttempt> | undefined {
	const redact = (field: InspectedText): InspectedText => typeof field === "string" ? omission(field, EFFECTIVE_PROMPT_CALL_LIMIT, "aggregate call limit exceeded") : field;
	return normalizeEffectivePrompt({ ...value, systemPrompt: redact(value.systemPrompt), firstUserMessage: redact(value.firstUserMessage) }) as Readonly<EffectivePromptAttempt> | undefined;
}
export function aggregateOmission(firstOrder: number, lastOrder = firstOrder, count = 1): Readonly<EffectivePromptAggregateOmission> {
	return Object.freeze({ schemaVersion: EFFECTIVE_PROMPT_SCHEMA_VERSION, kind: "aggregate_omission", reason: "capture entry limit exceeded", omittedAttemptCount: count, firstOrder, lastOrder });
}
export function extendAggregateOmission(value: EffectivePromptAggregateOmission, order: number): Readonly<EffectivePromptAggregateOmission> {
	return aggregateOmission(value.firstOrder, order, value.omittedAttemptCount + 1);
}
export function renderInspectedText(value: InspectedText): string { return typeof value === "string" ? value : `[omitted: ${value.reason}; ${value.originalBytes} bytes, limit ${value.limitBytes}]`; }
export function renderEffectivePromptAttempt(value: EffectivePromptCaptureEntry): string {
	if (value.kind === "aggregate_omission") return `[${value.omittedAttemptCount} prompt attempts omitted; call-wide orders ${value.firstOrder}–${value.lastOrder}: ${value.reason}]`;
	const thinking = value.thinkingLevel ? ` · thinking ${renderInspectedText(value.thinkingLevel)}` : "";
	return `Attempt ${value.order} · runtime model ${renderInspectedText(value.provider)}/${renderInspectedText(value.model)}${thinking}\nWorking directory: ${renderInspectedText(value.cwd)}\nActive tools: ${value.activeTools.map(renderInspectedText).join(", ") || "(none)"}\n\nSystem prompt\n${renderInspectedText(value.systemPrompt)}\n\nFirst user message\n${renderInspectedText(value.firstUserMessage)}`;
}
