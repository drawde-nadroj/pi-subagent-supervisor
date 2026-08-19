import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "../src/agents.ts";
import { emptyUsage, type RunEvent, type RunHandle, type RunResult } from "../src/engine.ts";
import { terminalOutputSummary } from "../src/message-presentation.ts";
import { RESULT_CAP_BYTES, RESULT_TRUNCATION_MARKER, RunRegistry, type CallSnapshot } from "../src/registry.ts";
import { detailsFromSnapshot, dispatchParallel, dispatchSequence, dispatchSingle, formatParallelResult, registerSubagentTool, type DispatchDeps } from "../src/tool.ts";

assert.equal(formatParallelResult(["worker", "worker"], [
	{ ok: false, finalText: "(no output)", usage: emptyUsage(), contextPercent: null, error: "aborted" },
	{ ok: false, finalText: "partial answer", usage: emptyUsage(), contextPercent: null, error: "aborted" },
]), "Parallel: 0/2 succeeded\n\n### [worker] failed\n\naborted\n\n---\n\n### [worker] failed\n\npartial answer");

const agent = (name: string, fallback: string[] = []): AgentConfig =>
	({
		name,
		displayName: name,
		description: "",
		color: "cyan",
		readonly: false,
		conventions: false,
		spawn: [],
		fallback,
		systemPrompt: "",
		source: "user",
		filePath: `/tmp/${name}.md`,
	}) as AgentConfig;

const model = { provider: "mock", id: "parent" } as any;
const modelRegistry = {
	getAll: () => [model, { provider: "mock", id: "fallback" }],
	find: (provider: string, id: string) => ({ provider, id }),
} as any;
const baseCtx = { cwd: "/tmp/project", model, modelRegistry } as any;

const handle = (result: RunResult, onEvent: (event: RunEvent) => void): Promise<RunHandle> => {
	onEvent({ type: "status", status: "running" });
	onEvent({ type: "usage", usage: result.usage, contextPercent: result.contextPercent });
	return Promise.resolve({ promise: Promise.resolve(result), abort() {} });
};

for (const ok of [true, false]) {
	const oversized = "x".repeat(RESULT_CAP_BYTES + 1);
	const result = await dispatchSingle({
		registry: new RunRegistry(),
		getCtx: () => baseCtx,
		executeAgent: async (args) => handle({
			ok,
			finalText: oversized,
			error: ok ? undefined : oversized,
			usage: emptyUsage(),
			contextPercent: null,
		}, args.onEvent),
	}, agent(ok ? "large-success" : "large-failure"), "return a large result");
	assert.ok(Buffer.byteLength(result.finalText, "utf8") <= RESULT_CAP_BYTES);
	assert.ok(result.finalText.endsWith(RESULT_TRUNCATION_MARKER));
	if (!ok) {
		assert.ok(Buffer.byteLength(result.error!, "utf8") <= RESULT_CAP_BYTES);
		assert.ok(result.error!.endsWith(RESULT_TRUNCATION_MARKER));
	}
}

// The model sees the registered TypeBox schema, not the local RetryConfig
// symbol. Keep the retry object's sequence-only semantics at that boundary.
{
	let registered: any;
	registerSubagentTool({
		registerTool(tool: unknown) {
			registered = tool;
		},
	} as any, {
		registry: new RunRegistry(),
		getCtx: () => baseCtx,
	});
	assert.equal(
		registered.parameters.properties.retry.description,
		"Optional sequence tail. Executes retrySteps up to maxRetries total attempts, continuing only after an execution failure.",
	);
	assert.match(registered.promptSnippet, /genuinely separate specialist stages/);
	assert.match(registered.promptSnippet, /execution failure/);
	assert.match(registered.description, /explicitly named by the user may be invoked/);
	assert.doesNotMatch(registered.description, /hidden-secret/);
	assert.match(registered.promptGuidelines.join(" "), /parallel mode is for independent work/);
	assert.match(registered.promptGuidelines.join(" "), /do not manufacture parallelism/);
	assert.ok(registered.promptGuidelines.every((line: string) => /subagent/i.test(line)), "every flattened guideline names subagent");
	assert.doesNotMatch(registered.description, /until clean|last step succeeds/);
	assert.doesNotMatch(registered.promptGuidelines.join(" "), /until clean|verdict-aware/);
}

// Publish render-ready live snapshots for meaningful activity. This must make
// the running agent/task and concrete tool use visible without forwarding text,
// usage, or timer churn into Pi's transcript row.
{
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-scroll-"));
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "agents", "scroll-probe.md"), [
		"---",
		"name: scroll-probe",
		"description: Test transcript update cadence.",
		"auto: true",
		"---",
		"Return a result.",
	].join("\n"));
	try {
		let registered: any;
		let release!: (result: RunResult) => void;
		const registry = new RunRegistry();
		registerSubagentTool({ registerTool(tool: unknown) { registered = tool; } } as any, {
			registry,
			getCtx: () => ({ ...baseCtx, cwd }),
			executeAgent: async (args) => {
				args.onEvent({ type: "status", status: "running" });
				args.onEvent({ type: "tool", name: "read", argsPreview: "read tool.ts" });
				args.onEvent({ type: "text", text: "intermediate text" });
				args.onEvent({ type: "usage", usage: { ...emptyUsage(), toolCalls: 1 }, contextPercent: 10 });
				return {
					promise: new Promise<RunResult>((resolve) => { release = resolve; }),
					abort() {},
				};
			},
		});
		const updates: any[] = [];
		const execution = registered.execute(
			"scroll-probe",
			{ agent: "scroll-probe", task: "trace scroll" },
			undefined,
			(update: unknown) => updates.push(update),
			{ cwd, isProjectTrusted: () => true },
		);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(updates.length, 2, "start and concrete tool activity must appear before execution completes");
		assert.equal(updates[0].details.call.roots[0].status, "active");
		assert.equal(updates[0].details.call.roots[0].task, "trace scroll");
		assert.equal(updates[1].details.call.roots[0].activity.tool, "read");
		assert.deepEqual(updates[1].details.call.roots[0].toolLog, ["read tool.ts"]);
		release({ ok: true, finalText: "done", usage: { ...emptyUsage(), toolCalls: 1 }, contextPercent: 10 });
		const result = await execution;
		assert.equal(updates.length, 2, "text, usage, and terminal handoff must not redraw the live transcript row");
		assert.equal(result.details.call.counts.finished, 1);
		assert.equal(result.details.call.roots[0].toolLog[0], "read tool.ts");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

// Delegation bookkeeping is hidden by the renderer, so it must not publish an
// otherwise identical partial row before the nested agent becomes visible.
{
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nested-update-"));
	const agentDir = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "parent-probe.md"), [
		"---",
		"name: parent-probe",
		"description: Test nested transcript updates.",
		"auto: true",
		"spawn: [child-probe]",
		"---",
		"Delegate once.",
	].join("\n"));
	fs.writeFileSync(path.join(agentDir, "child-probe.md"), [
		"---",
		"name: child-probe",
		"description: Test nested transcript updates.",
		"auto: true",
		"---",
		"Read once.",
	].join("\n"));
	try {
		let registered: any;
		const registry = new RunRegistry();
		registerSubagentTool({ registerTool(tool: unknown) { registered = tool; } } as any, {
			registry,
			getCtx: () => ({ ...baseCtx, cwd }),
			resolveAgent: (name) => name === "child-probe" ? agent("child-probe") : undefined,
			executeAgent: async (args) => {
				if (args.agent.name === "parent-probe") {
					args.onEvent({ type: "tool", name: "subagent", argsPreview: "subagent child-probe" });
					assert.ok(args.spawn);
					const nestedResult = await args.spawn.runChild({ agent: agent("child-probe"), task: "inspect nested work", parentModel: model, depth: 1, allowSpawn: true });
					assert.ok(Buffer.byteLength(nestedResult.finalText, "utf8") <= RESULT_CAP_BYTES);
					assert.ok(nestedResult.finalText.endsWith(RESULT_TRUNCATION_MARKER));
					return handle({ ok: true, finalText: "parent done", usage: emptyUsage(), contextPercent: 10 }, args.onEvent);
				}
				args.onEvent({ type: "tool", name: "read", argsPreview: "read nested.ts" });
				return handle({ ok: true, finalText: "x".repeat(RESULT_CAP_BYTES + 1), usage: { ...emptyUsage(), toolCalls: 1 }, contextPercent: 10 }, args.onEvent);
			},
		});
		const updates: any[] = [];
		await registered.execute(
			"nested-update-probe",
			{ agent: "parent-probe", task: "delegate nested work" },
			undefined,
			(update: unknown) => updates.push(update),
			{ cwd, isProjectTrusted: () => true },
		);
		const visibleNode = (node: any): unknown => ({
			id: node.id,
			status: node.status,
			task: node.task,
			toolLog: node.toolLog.filter((entry: string) => !/^\s*subagent\b/i.test(entry)),
			children: node.children.map(visibleNode),
		});
		const visibleState = (update: any): string => JSON.stringify(update.details.call.roots.map(visibleNode));
		for (let index = 1; index < updates.length; index++) {
			assert.notEqual(visibleState(updates[index]), visibleState(updates[index - 1]), "every partial update must change the visible tree");
		}
		assert.ok(updates.some((update) => update.details.call.roots[0].children[0]?.toolLog.includes("read nested.ts")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

// Parallel roots are all planned dormant before execution and results retain
// request order even when completion order differs.
const parallelRegistry = new RunRegistry();
const planned: CallSnapshot[] = [];
const releases = new Map<string, () => void>();
const parallelDeps: DispatchDeps = {
	registry: parallelRegistry,
	getCtx: () => baseCtx,
	executeAgent: async (args) => {
		args.onEvent({ type: "status", status: "running" });
		await new Promise<void>((resolve) => releases.set(args.agent.name, resolve));
		const result = { ok: true, finalText: args.agent.name, usage: { ...emptyUsage(), cost: args.agent.name === "first" ? 0.01 : 0.02 }, contextPercent: null, model: `mock/${args.agent.name}` };
		args.onEvent({ type: "usage", usage: result.usage, contextPercent: null });
		return { promise: Promise.resolve(result), abort() {} };
	},
};
const parallelPromise = dispatchParallel(
	parallelDeps,
	[{ agent: agent("first"), task: "one" }, { agent: agent("second"), task: "two" }],
	undefined,
	(snapshot) => planned.push(snapshot),
);
await Promise.resolve();
assert.deepEqual(planned[0].counts, { total: 2, dormant: 2, active: 0, finished: 0, failed: 0 });
releases.get("second")!();
await Promise.resolve();
releases.get("first")!();
assert.deepEqual((await parallelPromise).map((result) => result.finalText), ["first", "second"]);

// A failed logical parallel branch is respawned once in place. Successful
// siblings are not repeated, result attribution remains in request order, and
// abort is terminal rather than a reason to respawn.
{
	const attempts = new Map<string, number>();
	const starts: string[] = [];
	const deps: DispatchDeps = {
		registry: new RunRegistry(),
		getCtx: () => baseCtx,
		executeAgent: async (args) => {
			const attempt = (attempts.get(args.agent.name) ?? 0) + 1;
			attempts.set(args.agent.name, attempt);
			starts.push(`${args.agent.name}:${attempt}`);
			if (args.agent.name === "throw-flaky" && attempt === 1) throw new Error("session construction failed");
			if (args.agent.name === "throw-broken") throw new Error("session construction failed again");
			if (args.agent.name === "reject-flaky" && attempt === 1) {
				return { promise: Promise.reject(new Error("child promise rejected")), abort() {} };
			}
			const ok = args.agent.name === "good"
				|| (args.agent.name === "flaky" && attempt === 2)
				|| (args.agent.name === "provider-flaky" && attempt === 2)
				|| (args.agent.name === "throw-flaky" && attempt === 2)
				|| (args.agent.name === "reject-flaky" && attempt === 2);
			const aborted = args.agent.name === "cancelled";
			const missingModel = args.agent.name === "missing-model";
			const providerFailure = args.agent.name === "provider-flaky";
			return handle({
				ok,
				finalText: ok ? `${args.agent.name} result` : "partial",
				usage: emptyUsage(),
				contextPercent: null,
				error: ok
					? undefined
					: aborted
						? "aborted"
						: missingModel
							? "No model available for pattern missing/model"
							: providerFailure
								? "provider unavailable (503)"
								: "ordinary task failure",
			}, args.onEvent);
		},
	};
	const results = await dispatchParallel(deps, [
		{ agent: agent("flaky"), task: "recover" },
		{ agent: agent("good"), task: "succeed once" },
		{ agent: agent("broken"), task: "fail twice" },
		{ agent: agent("cancelled"), task: "abort once" },
		{ agent: agent("provider-flaky"), task: "recover after exhausted provider attempts" },
		{ agent: agent("missing-model"), task: "fail before a usable model resolves" },
		{ agent: agent("throw-flaky"), task: "recover after construction throws" },
		{ agent: agent("throw-broken"), task: "stop after two construction throws" },
		{ agent: agent("reject-flaky"), task: "recover after child promise rejects" },
	]);
	assert.deepEqual(Object.fromEntries(attempts), {
		flaky: 2,
		good: 1,
		broken: 2,
		cancelled: 1,
		"provider-flaky": 2,
		"missing-model": 1,
		"throw-flaky": 2,
		"throw-broken": 2,
		"reject-flaky": 2,
	});
	assert.deepEqual(results.map((result) => [result.ok, result.finalText]), [
		[true, "flaky result"],
		[true, "good result"],
		[false, "partial"],
		[false, "partial"],
		[true, "provider-flaky result"],
		[false, "partial"],
		[true, "throw-flaky result"],
		[false, ""],
		[true, "reject-flaky result"],
	]);
	assert.ok(starts.indexOf("flaky:2") > starts.indexOf("flaky:1"), "respawn starts only after its failed physical attempt");
}

// Schema-backed returns are normalized once at the tracked execution boundary,
// so tool blocks, slash-command output, sequences, and stored snapshots agree.
{
	const structured = agent("structured");
	structured.returns = { type: "object", properties: { verdict: { type: "string" } } };
	const registry = new RunRegistry();
	let completed: CallSnapshot | undefined;
	const result = await dispatchSingle({
		registry,
		getCtx: () => baseCtx,
		executeAgent: async (args) => handle({
			ok: true,
			finalText: 'Done.\n```json\n{"verdict":"approve"}\n```',
			usage: emptyUsage(),
			contextPercent: null,
		}, args.onEvent),
	}, structured, "review", undefined, { onComplete: (snapshot) => { completed = snapshot; } });
	const expected = 'Done.\n```json\n{\n  "verdict": "approve"\n}\n```';
	assert.equal(result.finalText, expected);
	assert.equal(completed?.roots[0].finalText, expected);
}

// Provider fallback attempts remain one logical node and accumulate each
// attempt's spend exactly once.
const fallbackRegistry = new RunRegistry();
let fallbackAttempt = 0;
const fallbackDeps: DispatchDeps = {
	registry: fallbackRegistry,
	getCtx: () => baseCtx,
	executeAgent: async (args) => {
		fallbackAttempt += 1;
		const result: RunResult = fallbackAttempt === 1
			? { ok: false, finalText: "", usage: { ...emptyUsage(), input: 10, output: 2, cost: 0.02 }, contextPercent: 20, model: "mock/primary", error: "503 unavailable" }
			: { ok: true, finalText: "recovered", usage: { ...emptyUsage(), input: 20, output: 3, cost: 0.03 }, contextPercent: 30, model: "mock/fallback" };
		return handle(result, args.onEvent);
	},
};
const fallbackResult = (await dispatchParallel(fallbackDeps, [{ agent: agent("worker", ["mock/fallback"]), task: "work" }]))[0];
assert.equal(fallbackResult.usage.input, 30);
assert.equal(fallbackResult.usage.output, 5);
assert.equal(fallbackResult.usage.cost, 0.05);
assert.equal(fallbackResult.model, "mock/fallback");
assert.equal(fallbackRegistry.activeCallSnapshots().length, 0);
assert.equal(fallbackRegistry.totalCost(), 0.05);

// Retry roots appear only as their attempts begin; an unused configured retry
// never inflates dormant/total counts.
const retryRegistry = new RunRegistry();
const finishedCalls: CallSnapshot[] = [];
retryRegistry.onCallFinish((snapshot) => finishedCalls.push(snapshot));
let retryRuns = 0;
const retryDeps: DispatchDeps = {
	registry: retryRegistry,
	getCtx: () => baseCtx,
	executeAgent: async (args) => {
		const isRetry = args.task.includes("retry");
		if (isRetry) retryRuns += 1;
		const ok = !isRetry || retryRuns === 2;
		return handle({
			ok,
			finalText: ok ? "ok" : "try again",
			usage: { ...emptyUsage(), cost: 0.01 },
			contextPercent: null,
			model: "mock/parent",
			error: ok ? undefined : "ordinary task failure",
		}, args.onEvent);
	},
};
await dispatchSequence(
	retryDeps,
	[{ agent: agent("worker"), task: "main" }],
	{ maxRetries: 3, retrySteps: [{ agent: agent("reviewer"), task: "retry {previous}" }] },
);
assert.equal(retryRuns, 2);
assert.equal(finishedCalls.length, 1);
assert.equal(finishedCalls[0].counts.total, 3);
assert.equal(finishedCalls[0].counts.dormant, 0);
assert.equal(finishedCalls[0].retryConfigured, 3);
const persistedDetails = JSON.parse(JSON.stringify(detailsFromSnapshot(finishedCalls[0])));
assert.equal(persistedDetails.schemaVersion, 2);
assert.equal(persistedDetails.revision, finishedCalls[0].revision);
assert.deepEqual(persistedDetails.call, JSON.parse(JSON.stringify(finishedCalls[0])));

// A thrown session-construction/execution failure must terminalize both the
// node and call instead of leaving an active zombie in running().
const thrownRegistry = new RunRegistry();
const thrownCalls: CallSnapshot[] = [];
thrownRegistry.onCallFinish((snapshot) => thrownCalls.push(snapshot));
const thrownResult = await dispatchSingle({
	registry: thrownRegistry,
	getCtx: () => baseCtx,
	executeAgent: async () => { throw new Error("session construction failed"); },
}, agent("worker"), "throw");
assert.equal(thrownResult.ok, false);
assert.match(thrownResult.error ?? "", /session construction failed/);
assert.equal(thrownRegistry.running().length, 0);
assert.equal(thrownCalls.length, 1);
assert.equal(thrownCalls[0].counts.failed, 1);
assert.equal(thrownCalls[0].launchSurface, "foreground");

// A caller can mark non-blocking dashboard/armed-sequence work as background;
// launch ownership survives through the terminal call snapshot.
const backgroundRegistry = new RunRegistry();
const backgroundCalls: CallSnapshot[] = [];
backgroundRegistry.onCallFinish((snapshot) => backgroundCalls.push(snapshot));
await dispatchSequence({
	registry: backgroundRegistry,
	getCtx: () => baseCtx,
	executeAgent: async (args) => handle({
		ok: true,
		finalText: "done",
		usage: emptyUsage(),
		contextPercent: null,
		model: "mock/parent",
	}, args.onEvent),
}, [{ agent: agent("worker"), task: "background work" }], undefined, undefined, undefined, "background");
assert.equal(backgroundCalls[0].launchSurface, "background");

// A nested request records real lifecycle state in the same call graph rather
// than forwarding only a final callback/result.
let nestedNow = 1_000;
const nestedRegistry = new RunRegistry({ now: () => nestedNow });
const nestedCalls: CallSnapshot[] = [];
nestedRegistry.onCallFinish((snapshot) => nestedCalls.push(snapshot));
let nestedCompletion: CallSnapshot | undefined;
let nestedCompletionCount = 0;
const childAgent = agent("scout");
const parentAgent = { ...agent("worker"), spawn: ["scout"] };
const nestedResult = await dispatchSingle({
	registry: nestedRegistry,
	getCtx: () => baseCtx,
	resolveAgent: (name) => name === "scout" ? childAgent : undefined,
	executeAgent: async (args) => {
		if (args.agent.name === "worker") {
			assert.ok(args.spawn);
			await args.spawn.runChild({ agent: childAgent, task: "nested task", parentModel: model, depth: 1, allowSpawn: true });
			nestedNow += 1_000;
			return handle({ ok: true, finalText: "parent", usage: { ...emptyUsage(), cost: 0.01 }, contextPercent: 10, model: "mock/parent" }, args.onEvent);
		}
		args.onEvent({ type: "tool", name: "read", argsPreview: "read nested.ts" });
		nestedNow += 2_000;
		return handle({ ok: true, finalText: "nested answer", usage: { ...emptyUsage(), toolCalls: 1, cost: 0.02 }, contextPercent: 25, model: "mock/child" }, args.onEvent);
	},
}, parentAgent, "parent task", undefined, {
	onComplete: (snapshot) => {
		nestedCompletionCount++;
		nestedCompletion = snapshot;
	},
});
const nestedNode = nestedCalls[0].roots[0].children[0];
assert.equal(nestedNode.parentId, nestedCalls[0].roots[0].id);
assert.equal(nestedNode.role, "scout");
assert.equal(nestedNode.status, "success");
assert.deepEqual(nestedNode.toolLog, ["read nested.ts"]);
assert.equal(nestedNode.usage.cost, 0.02);
assert.equal(nestedNode.model, "mock/child");
assert.equal(nestedNode.finalText, "nested answer");
assert.ok(nestedCompletion);
assert.equal(nestedCompletionCount, 1, "dispatch completion must fire exactly once");
assert.notEqual(nestedCompletion.finishedAt, undefined, "dispatch completion must only expose a terminal call");
assert.deepEqual(nestedCompletion, nestedCalls[0], "dispatch completion must expose the authoritative terminal snapshot");
assert.deepEqual(terminalOutputSummary(nestedResult, nestedCompletion), {
	ok: true,
	text: "parent",
	elapsedMs: 3_000,
	usage: { input: 0, output: 0, cost: 0.03, tools: 1 },
});

// Single dispatch forwards a signal that was already aborted before execution.
const preAborted = new AbortController();
preAborted.abort();
let sawPreAborted = false;
const preAbortedResult = await dispatchSingle({
	registry: new RunRegistry(),
	getCtx: () => baseCtx,
	executeAgent: async (args) => {
		sawPreAborted = args.signal === preAborted.signal && args.signal.aborted;
		return {
			promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "aborted" }),
			abort() {},
		};
	},
}, agent("worker"), "cancel before start", undefined, { signal: preAborted.signal });
assert.equal(sawPreAborted, true);
assert.equal(preAbortedResult.error, "aborted");

// Single dispatch also propagates in-flight cancellation and retains usage
// emitted while the aborted execution settles.
const inFlightController = new AbortController();
const inFlightRegistry = new RunRegistry();
let releaseAborted!: (result: RunResult) => void;
const inFlightPromise = dispatchSingle({
	registry: inFlightRegistry,
	getCtx: () => baseCtx,
	executeAgent: async (args) => ({
		promise: new Promise<RunResult>((resolve) => {
			releaseAborted = resolve;
			args.signal?.addEventListener("abort", () => {
				const usage = { ...emptyUsage(), input: 7, cost: 0.04 };
				args.onEvent({ type: "usage", usage, contextPercent: 18 });
				resolve({ ok: false, finalText: "", usage, contextPercent: 18, error: "aborted" });
			}, { once: true });
		}),
		abort() {},
	}),
}, agent("worker"), "cancel in flight", undefined, { signal: inFlightController.signal });
await Promise.resolve();
inFlightController.abort();
const inFlightResult = await inFlightPromise;
assert.equal(inFlightResult.error, "aborted");
assert.equal(inFlightResult.usage.cost, 0.04);
assert.equal(inFlightRegistry.totalCost(), 0.04);

// Killing a planned sequence sees/stops only its active root. Future dormant
// roots are abandoned by orchestration without history entries.
const killRegistry = new RunRegistry();
const killedHistory: string[] = [];
killRegistry.onFinish((record) => killedHistory.push(record.task));
let releaseKilled!: (result: RunResult) => void;
const killSequence = dispatchSequence({
	registry: killRegistry,
	getCtx: () => baseCtx,
	executeAgent: async () => ({
		promise: new Promise<RunResult>((resolve) => { releaseKilled = resolve; }),
		abort() {
			releaseKilled({ ok: false, finalText: "", usage: { ...emptyUsage(), cost: 0.02 }, contextPercent: null, error: "aborted" });
		},
	}),
}, [
	{ agent: agent("first"), task: "active step" },
	{ agent: agent("second"), task: "planned step" },
	{ agent: agent("third"), task: "another planned step" },
]);
await Promise.resolve();
const killTargets = killRegistry.running();
assert.deepEqual(killTargets.map((record) => record.task), ["active step"]);
for (const record of killTargets) killRegistry.stop(record);
await killSequence;
assert.deepEqual(killedHistory, ["active step"]);
assert.equal(killRegistry.running().length, 0);

console.log("tool unit tests passed");
