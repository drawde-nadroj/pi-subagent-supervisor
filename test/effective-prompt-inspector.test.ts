import assert from "node:assert/strict";
import { EFFECTIVE_PROMPT_ATTEMPT_LIMIT, EFFECTIVE_PROMPT_CALL_LIMIT, EFFECTIVE_PROMPT_FIELD_LIMIT, inspectEffectivePrompt, normalizeEffectivePrompt, renderEffectivePromptAttempt } from "../src/effective-prompt.ts";
import { emptyUsage } from "../src/engine.ts";
import { createPersona } from "../src/persona.ts";
import { RunRegistry } from "../src/registry.ts";
import { entryFromRecord } from "../src/runlog.ts";
import { normalizeV2Details, renderSubagentCall, renderSubagentResult, type SubagentRendererTheme } from "../src/tool-renderer.ts";

const oversized = "é".repeat(EFFECTIVE_PROMPT_FIELD_LIMIT);
const bounded = inspectEffectivePrompt({ order: 1, systemPrompt: oversized, firstUserMessage: "Task: test", provider: "p", model: "m", thinkingLevel: "high", activeTools: ["read"], cwd: "/tmp" });
assert.equal(typeof bounded.systemPrompt, "object");
assert.equal((bounded.systemPrompt as any).originalBytes, Buffer.byteLength(oversized));
assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= EFFECTIVE_PROMPT_ATTEMPT_LIMIT);
assert.ok(Object.isFrozen(bounded));
assert.ok(Object.isFrozen(bounded.activeTools));
assert.match(renderEffectivePromptAttempt(bounded), /Attempt 1 · runtime model p\/m/);
assert.match(renderEffectivePromptAttempt(bounded), /First user message\nTask: test/);
const metadataHeavy = inspectEffectivePrompt({
	order: 2, systemPrompt: "system", firstUserMessage: "Task: test",
	provider: "p".repeat(4096), model: "m".repeat(4096), thinkingLevel: "h".repeat(4096), cwd: "/".repeat(2048),
	activeTools: Array.from({ length: 256 }, (_, i) => `${i}-` + "t".repeat(4090)),
});
assert.ok(Buffer.byteLength(JSON.stringify(metadataHeavy), "utf8") <= EFFECTIVE_PROMPT_ATTEMPT_LIMIT, "metadata-heavy attempts remain bounded");
assert.equal(typeof metadataHeavy.activeTools[0], "object", "over-budget tool metadata is an explicit omission");

const registry = new RunRegistry({ now: () => 10 });
const call = registry.createCall({ mode: "single", cwd: "/tmp" });
const agent: any = { name: "worker", displayName: "Worker", description: "", color: "cyan", fallback: [], auto: true, readonly: false, conventions: false, spawn: [], systemPrompt: "", source: "user", filePath: "x" };
const runId = call.planRoot(agent, "test", createPersona(agent));
call.start(runId);
const prompt = inspectEffectivePrompt({ order: 99, systemPrompt: "system", firstUserMessage: "Task: test", provider: "p", model: "m", activeTools: [], cwd: "/tmp" });
let captureNotifications = 0;
const stopCaptureNotifications = registry.onChange(() => captureNotifications++);
call.applyEvent(runId, { type: "pre_prompt", prompt });
assert.equal(captureNotifications, 0, "capture does not publish live registry updates");
stopCaptureNotifications();
const aggregateText = "x".repeat(15 * 1024);
for (let i = 0; i < 5; i++) call.applyEvent(runId, { type: "pre_prompt", prompt: inspectEffectivePrompt({ order: i + 2, systemPrompt: aggregateText, firstUserMessage: "Task: test", provider: "p", model: "m", activeTools: [], cwd: "/tmp" }) });
assert.equal(call.snapshot().roots[0].effectivePrompts, undefined, "partial snapshots redact prompt material");
assert.equal("effectivePrompts" in call.snapshot().roots[0], false, "partial snapshots structurally omit capture fields");
call.finish(runId, { ok: true, finalText: "done", usage: emptyUsage(), contextPercent: null });
call.finishCall({ ok: true });
const terminal = call.snapshot().roots[0].effectivePrompts!;
assert.equal(terminal.length, 6);
assert.equal(terminal[0].order, 1, "registry normalizes call-wide attempt order");
const aggregateBudgetAttempt = terminal.at(-1)!;
assert.equal(aggregateBudgetAttempt.kind, "attempt", "ordinary-budget overflow retains a per-attempt descriptor");
assert.deepEqual(aggregateBudgetAttempt, {
	schemaVersion: 1, kind: "attempt", order: 6,
	systemPrompt: { omitted: true, originalBytes: Buffer.byteLength(aggregateText), limitBytes: EFFECTIVE_PROMPT_CALL_LIMIT, reason: "aggregate call limit exceeded" },
	firstUserMessage: { omitted: true, originalBytes: Buffer.byteLength("Task: test"), limitBytes: EFFECTIVE_PROMPT_CALL_LIMIT, reason: "aggregate call limit exceeded" },
	provider: "p", model: "m", activeTools: [], cwd: "/tmp",
}, "aggregate ordinary budget omits only prompt text and preserves metadata with exact byte counts");
assert.match(renderEffectivePromptAttempt(aggregateBudgetAttempt), /Attempt 6 · runtime model p\/m/);
assert.match(renderEffectivePromptAttempt(aggregateBudgetAttempt), /System prompt\n\[omitted: aggregate call limit exceeded; 15360 bytes, limit 98304\]/);
assert.ok(terminal.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0) <= EFFECTIVE_PROMPT_CALL_LIMIT, "capture remains within the hard call budget");
assert.ok(Object.isFrozen(terminal));
assert.ok(Object.isFrozen((terminal[0] as any).activeTools));
assert.ok(Object.isFrozen(bounded.systemPrompt), "generated nested omissions are frozen");
assert.throws(() => { (terminal[0] as any).activeTools.push("evil"); }, TypeError);

const cappedRegistry = new RunRegistry({ now: () => 20 });
const cappedCall = cappedRegistry.createCall({ mode: "parallel", cwd: "/tmp" });
const cappedRuns = [cappedCall.planRoot(agent, "one", createPersona(agent)), cappedCall.planRoot(agent, "two", createPersona(agent))];
for (const id of cappedRuns) cappedCall.start(id);
for (let i = 0; i < 71; i++) cappedCall.applyEvent(cappedRuns[i % 2], { type: "pre_prompt", prompt: inspectEffectivePrompt({ order: i + 1, systemPrompt: "s", firstUserMessage: "u", provider: "p", model: `m${i}`, activeTools: [], cwd: "/tmp" }) });
for (const id of cappedRuns) cappedCall.finish(id, { ok: true, finalText: "done", usage: emptyUsage(), contextPercent: null });
cappedCall.finishCall({ ok: true });
const cappedPrompts = cappedCall.snapshot().roots.flatMap((root) => root.effectivePrompts ?? []);
assert.equal(cappedPrompts.length, 64, "attempt cap is call-wide across roots");
const aggregate = cappedPrompts.find((value) => value.kind === "aggregate_omission");
assert.deepEqual(aggregate, { schemaVersion: 1, kind: "aggregate_omission", reason: "capture entry limit exceeded", omittedAttemptCount: 8, firstOrder: 64, lastOrder: 71 }, "all intermediate attempts are represented by a stable count and range");
assert.equal(cappedCall.snapshot().roots[1].effectivePrompts?.at(-1)?.kind, "aggregate_omission", "marker stays on the first omitted attempt's root");

const malicious = { ...bounded, systemPrompt: { omitted: true, originalBytes: 1, limitBytes: 1, reason: "x".repeat(1024 * 1024) } };
assert.equal(normalizeEffectivePrompt(malicious), undefined, "oversized or unknown omission reasons fail closed");
assert.equal(normalizeEffectivePrompt({ ...bounded, systemPrompt: { omitted: true, originalBytes: 10, limitBytes: 1, reason: "field limit exceeded" } }), undefined, "omission limits must match their field");
assert.equal(normalizeEffectivePrompt({ schemaVersion: 1, kind: "aggregate_omission", reason: "capture entry limit exceeded", omittedAttemptCount: 1, firstOrder: 5, lastOrder: 10 }), undefined, "aggregate count must match its range");

const detachRegistry = new RunRegistry({ now: () => 30 });
const detachCall = detachRegistry.createCall({ mode: "single" });
const detachRun = detachCall.planRoot(agent, "detach", createPersona(agent));
detachCall.start(detachRun);
const suppliedOmission: any = { omitted: true, originalBytes: 12, limitBytes: EFFECTIVE_PROMPT_FIELD_LIMIT, reason: "field limit exceeded" };
const supplied: any = { ...prompt, systemPrompt: suppliedOmission };
detachCall.applyEvent(detachRun, { type: "pre_prompt", prompt: supplied });
suppliedOmission.originalBytes = 999;
detachCall.finish(detachRun, { ok: true, finalText: "done", usage: emptyUsage(), contextPercent: null });
detachCall.finishCall({ ok: true });
const detached = detachCall.snapshot().roots[0].effectivePrompts![0] as any;
assert.equal(detached.systemPrompt.originalBytes, 12, "registry deep-detaches incoming nested omissions");
assert.ok(Object.isFrozen(detached.systemPrompt), "registry snapshot deeply freezes nested omissions");
console.log("effective prompt inspector unit tests passed");

// Public session-factory seam: capture reads authoritative runtime APIs at launch,
// preserves the exact first message, and never captures the repair turn.
const { runAgent } = await import("../src/engine.ts");
let systemReads = 0;
let toolReads = 0;
const prompted: string[] = [];
const events: any[] = [];
const fakeSession: any = {
	get systemPrompt() { systemReads++; return "runtime system"; },
	model: { provider: "runtime-provider", id: "runtime-model" },
	thinkingLevel: "high",
	getActiveToolNames() { toolReads++; return ["runtime-tool"]; },
	subscribe() { return () => {}; },
	getContextUsage() { return null; },
	async prompt(message: string) { prompted.push(message); },
	getLastAssistantText() { return prompted.length === 1 ? "invalid" : "valid"; },
	async abort() {},
	dispose() {},
};
const runtimeAgent: any = { ...agent, systemPrompt: "configured system", model: undefined, thinking: "low", tools: [] };
const runtimeModel: any = { provider: "configured-provider", id: "configured-model" };
const launchInput = "assigned\n\nReturn exactly: structured contract";
const handle = await runAgent({
	agent: runtimeAgent, task: launchInput, parentModel: runtimeModel,
	registry: { getAll: () => [runtimeModel] } as any, cwd: "/runtime", conventions: false,
	promptCaptureEnabled: () => true, createSession: async () => fakeSession,
	validate: () => "repair message", onEvent: (event) => events.push(event),
});
await handle.promise;
const captures = events.filter((event) => event.type === "pre_prompt");
assert.equal(captures.length, 1, "repair turn has no capture");
assert.equal(captures[0].prompt.systemPrompt, "runtime system");
assert.deepEqual(captures[0].prompt.activeTools, ["runtime-tool"]);
assert.equal(captures[0].prompt.firstUserMessage, `Task: ${launchInput}`);
assert.deepEqual(prompted, [`Task: ${launchInput}`, "repair message"]);
assert.equal(systemReads, 1);
assert.equal(toolReads, 1);

// The privacy gate short-circuits before touching either prompt-bearing runtime API.
let gatedSystemReads = 0;
let gatedToolReads = 0;
const gatedEvents: any[] = [];
const gatedSession: any = {
	get systemPrompt() { gatedSystemReads++; return "must not read"; },
	model: runtimeModel, thinkingLevel: "low",
	getActiveToolNames() { gatedToolReads++; return ["must-not-read"]; },
	subscribe() { return () => {}; }, getContextUsage() { return null; },
	async prompt() {}, getLastAssistantText() { return "done"; }, async abort() {}, dispose() {},
};
const gatedHandle = await runAgent({
	agent: runtimeAgent, task: "private", parentModel: runtimeModel, registry: { getAll: () => [runtimeModel] } as any,
	cwd: "/runtime", conventions: false, promptCaptureEnabled: () => false,
	createSession: async () => gatedSession, onEvent: (event) => gatedEvents.push(event),
});
await gatedHandle.promise;
assert.equal(gatedSystemReads, 0, "gate off does not read the system prompt API");
assert.equal(gatedToolReads, 0, "gate off does not read the active-tools API");
assert.equal(gatedEvents.some((event) => event.type === "pre_prompt"), false, "gate off emits no capture");

// Fallback/respawn launches remain separate attempts in launch order.
const orderedRegistry = new RunRegistry({ now: () => 40 });
const orderedCall = orderedRegistry.createCall({ mode: "single" });
const orderedRun = orderedCall.planRoot(agent, "fallback", createPersona(agent));
orderedCall.start(orderedRun);
for (const [order, provider, model] of [[1, "primary", "alpha"], [2, "fallback", "beta"], [3, "fallback", "beta"]] as const) {
	orderedCall.applyEvent(orderedRun, { type: "pre_prompt", prompt: inspectEffectivePrompt({ order, systemPrompt: `system-${order}`, firstUserMessage: "Task: fallback", provider, model, activeTools: [], cwd: "/tmp" }) });
}
orderedCall.finish(orderedRun, { ok: true, finalText: "done", usage: emptyUsage(), contextPercent: null });
orderedCall.finishCall({ ok: true });
assert.deepEqual(orderedCall.snapshot().roots[0].effectivePrompts?.map(({ order, provider, model, systemPrompt }) => ({ order, provider, model, systemPrompt })), [
	{ order: 1, provider: "primary", model: "alpha", systemPrompt: "system-1" },
	{ order: 2, provider: "fallback", model: "beta", systemPrompt: "system-2" },
	{ order: 3, provider: "fallback", model: "beta", systemPrompt: "system-3" },
], "provider fallback and immediate respawn are ordered, distinct attempts");

// A nested node owns its capture; neither capture leaks into the other node.
const nestedRegistry = new RunRegistry({ now: () => 50 });
const nestedCall = nestedRegistry.createCall({ mode: "single" });
const parentId = nestedCall.planRoot(agent, "parent canonical task", createPersona(agent));
const childId = nestedCall.spawnChild(parentId, agent, "child canonical task", createPersona(agent));
for (const [id, text] of [[parentId, "parent prompt"], [childId, "child prompt"]] as const) {
	nestedCall.start(id);
	nestedCall.applyEvent(id, { type: "pre_prompt", prompt: inspectEffectivePrompt({ order: 1, systemPrompt: text, firstUserMessage: `Task: ${text}`, provider: "p", model: "m", activeTools: [], cwd: "/tmp" }) });
	nestedCall.finish(id, { ok: true, finalText: id === parentId ? "parent answer" : "child answer", usage: emptyUsage(), contextPercent: null });
}
nestedCall.finishCall({ ok: true });
const nestedSnapshot = nestedCall.snapshot();
assert.deepEqual(nestedSnapshot.roots[0].effectivePrompts?.map((p: any) => p.systemPrompt), ["parent prompt"]);
assert.deepEqual(nestedSnapshot.roots[0].children[0].effectivePrompts?.map((p: any) => p.systemPrompt), ["child prompt"]);
assert.deepEqual([nestedSnapshot.roots[0].task, nestedSnapshot.roots[0].finalText, nestedSnapshot.roots[0].children[0].task, nestedSnapshot.roots[0].children[0].finalText], ["parent canonical task", "parent answer", "child canonical task", "child answer"], "canonical parent/child content is unchanged");

const terminalDetails: any = { schemaVersion: 2, revision: nestedSnapshot.revision, call: nestedSnapshot };
const partialDetails: any = structuredClone(terminalDetails);
delete partialDetails.call.finishedAt;
const partialNormalized = normalizeV2Details(partialDetails)!;
assert.equal("effectivePrompts" in partialNormalized.call.roots[0], false, "partial V2 structurally omits prompt keys");
assert.equal(JSON.stringify(partialNormalized).includes("effectivePrompts"), false, "serialized partial V2 contains no prompt keys");
assert.equal((normalizeV2Details(terminalDetails)!.call.roots[0].effectivePrompts?.length), 1, "terminal V2 retains captures");
const oldV2: any = structuredClone(terminalDetails);
const strip = (node: any) => { delete node.effectivePrompts; node.children.forEach(strip); };
oldV2.call.roots.forEach(strip);
assert.ok(normalizeV2Details(oldV2), "old V2 without optional prompt keys restores");

const mixedV2: any = structuredClone(terminalDetails);
mixedV2.call.roots[0].effectivePrompts = [{ nonsense: true }];
const mixedNormalized = normalizeV2Details(mixedV2)!;
assert.equal(mixedNormalized.call.roots[0].task, "parent canonical task", "malformed optional capture does not lose its valid row");
assert.equal(mixedNormalized.call.roots[0].effectivePrompts, undefined, "malformed optional capture fails closed");
const overCapV2: any = structuredClone(terminalDetails);
overCapV2.call.roots[0].effectivePrompts = Array.from({ length: 65 }, () => prompt);
assert.equal(normalizeV2Details(overCapV2)!.call.roots[0].effectivePrompts, undefined, "over-cap optional capture fails closed");

const theme: SubagentRendererTheme = { fg: (_color, text) => text, bold: (text) => text };
const render = (expanded: boolean, width: number): string => {
	const state: any = {};
	const args = { agent: "worker", task: "parent canonical task" };
	renderSubagentCall(args, theme, { args, state, lastComponent: undefined });
	return renderSubagentResult({ content: [{ type: "text", text: "done" }], details: terminalDetails }, { expanded, isPartial: false }, theme, { args, state, lastComponent: undefined }).render(width).join("\n");
};
assert.doesNotMatch(render(false, 80), /Effective prompt|parent prompt|child prompt/, "collapsed rendering has no prompt material");
for (const width of [20, 24, 80]) {
	const expanded = render(true, width);
	assert.match(expanded, /Launch input/, `launch-input section label remains visible at width ${width}`);
	const literalOrder = expanded.replace(/\x1b\[[0-9:;]*m/g, "").replace(/[│╰─├]/g, "").replace(/\s+/g, "");
	assert.ok(literalOrder.includes("parentprompt") && literalOrder.includes("childprompt"), `root and nested literal prompts render at width ${width}`);
	assert.ok(literalOrder.indexOf("childprompt") < literalOrder.indexOf("parentprompt"), `nested-then-root literal blocks retain expanded tree order at width ${width}`);
	assert.ok(expanded.split("\n").every((line) => line.replace(/\x1b\[[0-9:;]*m/g, "").length <= width), `prompt rails stay bounded at width ${width}`);
}

const persisted = entryFromRecord(nestedRegistry.getRecord(parentId)!);
assert.equal(Object.keys(persisted).some((key) => /prompt/i.test(key)), false, "runs.jsonl schema gains no prompt field");
assert.doesNotMatch(JSON.stringify(persisted), /parent prompt|child prompt/, "runs.jsonl row contains no prompt strings");
console.log("effective prompt inspector focused requirements passed");
