import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { emptyUsage, type RunEvent, type RunResult, type RunUsage, runAgent } from "./engine.ts";
import { createNestedPersona, createRootPersonas } from "./persona.ts";
import type { LiveSurfaceCoordinator } from "./live-surface.ts";
import { capResult, type CallHandle, type CallSnapshot, type LaunchSurface, type RunId, type RunNodeSnapshot, type RunRecord, type RunRegistry } from "./registry.ts";
import { buildReturnsInstruction, checkReturns, formatReturnsJson } from "./returns.ts";
import { describeStructuredResult, resolveResultView, type ResultView } from "./result-view.ts";
import {
	normalizeV2Details,
	renderSubagentCall,
	renderSubagentResult,
	type SubagentRendererState,
	type SubagentToolDetailsV2,
} from "./tool-renderer.ts";

export const MAX_PARALLEL = 10;

export function substitutePrevious(task: string, previous: string): string {
	return task.replace(/\{previous\}/g, previous);
}

async function mapWithConcurrency<I, O>(items: I[], limit: number, fn: (item: I, i: number) => Promise<O>): Promise<O[]> {
	if (items.length === 0) return [];
	const n = Math.max(1, Math.min(limit, items.length));
	const out: O[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		new Array(n).fill(0).map(async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

const cap = capResult;

export function formatParallelResult(agentNames: readonly string[], results: readonly RunResult[]): string {
	const ok = results.filter((result) => result.ok).length;
	const text = results.map((result, index) => {
		const finalText = result.finalText.trim();
		const body = !result.ok && result.error && (!finalText || finalText === "(no output)")
			? result.error
			: finalText || result.error || "(no output)";
		return `### [${agentNames[index]}] ${result.ok ? "ok" : "failed"}\n\n${cap(body)}`;
	}).join("\n\n---\n\n");
	return `Parallel: ${ok}/${results.length} succeeded\n\n${text}`;
}

/** mm:ss elapsed, shared by transcript result surfaces. */
export function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Subscribe once to the registry's terminal event for a specific call. This
 * keeps completion callbacks honest even if a descendant outlives its root. */
function notifyWhenCallCompletes(
	registry: RunRegistry,
	callId: CallHandle["id"],
	onComplete: ((snapshot: CallSnapshot) => void) | undefined,
): Promise<void> | undefined {
	if (!onComplete) return undefined;
	return new Promise((resolve) => {
		const off = registry.onCallFinish((snapshot) => {
			if (snapshot.id !== callId) return;
			off();
			onComplete(snapshot);
			resolve();
		});
	});
}

// --- shared dispatch surface (dashboard / sequence routing) ---

export interface DispatchDeps {
	registry: RunRegistry;
	getCtx: () => ExtensionContext;
	/** Render a dispatched run's result into the transcript (for /name and sequences). */
	showOutput?: (agent: string, r: RunResult, snapshot?: CallSnapshot) => void;
	/** Settings gate for `returns:` schema enforcement. Default: enabled. */
	structuredReturns?: () => boolean;
	/** Whether routine renderer surfaces should reveal prices. Default: hidden. */
	showCosts?: () => boolean;
	/** Global structured-result presentation default. */
	resultView?: () => ResultView;
	/** Sole clock/invalidation owner for active transcript projections. */
	liveSurface?: Pick<LiveSurfaceCoordinator, "subscribeRenderer">;
	/** Test seam at the real engine boundary; production uses runAgent. */
	executeAgent?: typeof runAgent;
	/** Current user-turn prompt captured by before_agent_start; absent provenance fails closed. */
	currentUserPrompt?: () => string | undefined;
	/** Optional stable resolver for tests/embedded callers; production discovers from disk. */
	resolveAgent?: (name: string) => AgentConfig | undefined;
}

/** Provider-shaped failures that a fallback model can plausibly fix: quota, auth,
 * network, availability, 429/5xx. Deliberately excludes our own timeout/turnlimit/
 * aborted texts and ordinary task failures — a fallback must never re-run failed work. */
export function isProviderError(error: string | undefined): boolean {
	if (!error) return false;
	if (/timed out after|hit turn limit|^aborted$/i.test(error)) return false;
	return /quota|rate.?limit|\b429\b|\b40[13]\b|\b5\d\d\b|auth|billing|insufficient|overloaded|unavailable|no model available|ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network|internal server/i.test(error);
}

interface TrackedRunOptions {
	call: CallHandle;
	runId: RunId;
	signal?: AbortSignal;
	parentModel: ExtensionContext["model"];
	depth: number;
	/** False for nested parallel leaves, preventing transitive writable fan-out. */
	allowSpawn?: boolean;
	/** Retry this logical parallel branch once after an ordinary failure. */
	respawnOnFailure?: boolean;
	resolveAgent?: (name: string) => AgentConfig | undefined;
	onEvent?: (rec: RunRecord, e: RunEvent) => void;
}

function addUsage(left: RunUsage, right: RunUsage): RunUsage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cost: left.cost + right.cost,
		turns: left.turns + right.turns,
		toolCalls: left.toolCalls + right.toolCalls,
		contextTokens: left.contextTokens + right.contextTokens,
	};
}

/**
 * The one execution path for every root, fallback attempt, retry root, and
 * nested child. The supplied call graph is the only live-state owner.
 */
async function runTrackedNode(
	deps: DispatchDeps,
	agent: AgentConfig,
	task: string,
	options: TrackedRunOptions,
): Promise<RunResult> {
	const ctx = deps.getCtx();
	const rec = deps.registry.getRecord(options.runId);
	if (!rec) throw new Error(`Tracked run ${options.runId} was not planned`);
	options.call.start(options.runId);
	// Primary model first, then each fallback pattern — but only for provider-shaped
	// failures (quota/auth/network), never to re-run ordinary failed work.
	const attempts: AgentConfig[] = [agent, ...agent.fallback.map((m) => ({ ...agent, model: m }))];
	// Structured returns (gated by settings): append the schema contract to the task
	// and validate the final output, with one repair turn on mismatch.
	const schema = (deps.structuredReturns?.() ?? true) ? agent.returns : undefined;
	const finalTask = schema ? task + buildReturnsInstruction(schema) : task;
	const validate = schema ? (text: string) => checkReturns(schema, text) : undefined;
	let result: RunResult = { ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "no attempts" };
	let previousUsage = emptyUsage();
	let respawned = false;
	const executeAgent = deps.executeAgent ?? runAgent;
	try {
		for (let i = 0; i < attempts.length; i++) {
			const attempt = attempts[i];
			const resolveAgent = options.resolveAgent ?? makeResolveAgent(deps);
			let attemptUsage = emptyUsage();
			let attemptContextPercent = rec.contextPercent;
			let attemptResult: RunResult;
			try {
				const handle = await executeAgent({
					agent: attempt,
					task: finalTask,
					parentModel: options.parentModel,
					registry: ctx.modelRegistry,
					cwd: ctx.cwd,
					conventions: attempt.conventions,
					signal: options.signal,
					validate,
					spawn: options.allowSpawn !== false && attempt.spawn.length > 0 ? {
						depth: options.depth,
						resolveAgent,
						runChild: async (request) => {
							const persona = createNestedPersona({ role: rec.role, persona: rec.persona }, request.agent);
							const childId = options.call.spawnChild(options.runId, request.agent, request.task, persona);
							const childResult = await runTrackedNode(deps, request.agent, request.task, {
								call: options.call,
								runId: childId,
								parentModel: request.parentModel,
								depth: request.depth,
								signal: request.signal,
								allowSpawn: request.allowSpawn,
								respawnOnFailure: request.respawnOnFailure,
								resolveAgent,
							});
							return {
								...childResult,
								finalText: cap(childResult.finalText),
								error: childResult.error === undefined ? undefined : cap(childResult.error),
							};
						},
					} : undefined,
					onEvent: (e) => {
						if (e.type === "usage") {
							attemptUsage = e.usage;
							attemptContextPercent = e.contextPercent;
						}
						const trackedEvent: RunEvent = e.type === "usage"
							? { ...e, usage: addUsage(previousUsage, e.usage) }
							: e;
						options.call.applyEvent(options.runId, trackedEvent);
						options.onEvent?.(rec, trackedEvent);
					},
				});
				options.call.attachHandle(options.runId, handle);
				// No wall-clock cap here: engine.ts owns liveness via an idle timer (resets on
				// every tool call / assistant turn) plus a hard turn cap, so a busy child stays
				// alive and only a genuinely stuck or looping one is aborted.
				attemptResult = await handle.promise;
			} catch (error) {
				attemptResult = {
					ok: false,
					finalText: "",
					usage: attemptUsage,
					contextPercent: attemptContextPercent,
					model: rec.model,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			const canonicalText = schema ? formatReturnsJson(attemptResult.finalText) : attemptResult.finalText;
			const validStructured = schema && attemptResult.ok && checkReturns(schema, canonicalText) === null
				? describeStructuredResult(schema, canonicalText, resolveResultView(agent.resultView, deps.resultView?.() ?? "readable"))
				: undefined;
			result = {
				...attemptResult,
				finalText: canonicalText,
				structuredResult: validStructured,
				usage: addUsage(previousUsage, attemptResult.usage),
			};
			const aborted = options.signal?.aborted || /^aborted$/i.test(result.error ?? "");
			const providerFailure = isProviderError(result.error);
			const providerAttemptsExhausted = providerFailure && i === attempts.length - 1;
			const modelWasNeverResolved = /no model available/i.test(result.error ?? "");
			const retryableFailure = !result.ok
				&& !aborted
				&& (!providerFailure || (providerAttemptsExhausted && !modelWasNeverResolved));
			if (retryableFailure && options.respawnOnFailure && !respawned) {
				// Restart the complete logical branch once. Rebuild the remaining model
				// sequence so a provider fallback used by the first run is still available
				// to the fresh child session.
				attempts.splice(i + 1, attempts.length - i - 1, agent, ...agent.fallback.map((model) => ({ ...agent, model })));
				respawned = true;
				previousUsage = result.usage;
				continue;
			}
			if (result.ok || aborted || !providerFailure || i === attempts.length - 1) {
				if (i > 0 && result.ok && attempt.model !== agent.model) {
					try {
						ctx.ui?.notify?.(`${agent.name}: provider error on ${attempts[i - 1].model ?? "primary model"} — completed on fallback ${attempt.model}`, "warning");
					} catch {
						/* non-TUI */
					}
				}
				break;
			}
			previousUsage = result.usage;
		}
	} catch (error) {
		result = {
			ok: false,
			finalText: "",
			usage: { ...rec.usage },
			contextPercent: rec.contextPercent,
			model: rec.model,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		options.call.finish(options.runId, result);
	}
	return {
		...result,
		finalText: cap(result.finalText),
		error: result.error === undefined ? undefined : cap(result.error),
	};
}

export async function dispatchSingle(
	deps: DispatchDeps,
	agent: AgentConfig,
	task: string,
	onProgress?: (p: { tools: number; cost: number }) => void,
	opts?: {
		signal?: AbortSignal;
		onPlanned?: (snapshot: CallSnapshot) => void;
		onComplete?: (snapshot: CallSnapshot) => void;
		launchSurface?: LaunchSurface;
	},
): Promise<RunResult> {
	const ctx = deps.getCtx();
	const call = deps.registry.createCall({
		mode: "single",
		launchSurface: opts?.launchSurface ?? "foreground",
		cwd: ctx.cwd,
	});
	const terminalCompletion = notifyWhenCallCompletes(deps.registry, call.id, opts?.onComplete);
	const [persona] = createRootPersonas("single", [agent]);
	const runId = call.planRoot(agent, task, persona);
	opts?.onPlanned?.(call.snapshot());
	let result: RunResult = { ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "orchestration failed" };
	try {
		result = await runTrackedNode(deps, agent, task, {
			call,
			runId,
			parentModel: ctx.model,
			depth: 0,
			signal: opts?.signal,
			onEvent: (rec) => onProgress?.({ tools: rec.usage.toolCalls, cost: rec.usage.cost }),
		});
	} finally {
		call.finishCall({ ok: result.ok, error: result.error });
	}
	await terminalCompletion;
	return result;
}

/** Resolve an agent name against the current project's discovered agents (for spawn). */
function makeResolveAgent(deps: DispatchDeps): (name: string) => AgentConfig | undefined {
	if (deps.resolveAgent) return deps.resolveAgent;
	return (name: string) => {
		const ctx = deps.getCtx();
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		return agents.find((a) => a.name === name);
	};
}

export async function dispatchChain(
	deps: DispatchDeps,
	steps: Array<{ agent: AgentConfig; task: string }>,
	signal?: AbortSignal,
	launchSurface: LaunchSurface = "foreground",
	onComplete?: (snapshot: CallSnapshot) => void,
): Promise<RunResult> {
	return dispatchSequence(deps, steps, undefined, signal, undefined, launchSurface, onComplete);
}

export async function dispatchParallel(
	deps: DispatchDeps,
	tasks: Array<{ agent: AgentConfig; task: string }>,
	signal?: AbortSignal,
	onPlanned?: (snapshot: CallSnapshot) => void,
	launchSurface: LaunchSurface = "foreground",
): Promise<RunResult[]> {
	const ctx = deps.getCtx();
	const call = deps.registry.createCall({ mode: "parallel", launchSurface, cwd: ctx.cwd });
	const personas = createRootPersonas("parallel", tasks.map((task) => task.agent));
	const runIds = tasks.map((task, index) => call.planRoot(task.agent, task.task, personas[index]));
	onPlanned?.(call.snapshot());
	let results: RunResult[] = [];
	try {
		results = await mapWithConcurrency(tasks, MAX_PARALLEL, (task, index) =>
			runTrackedNode(deps, task.agent, task.task, {
				call,
				runId: runIds[index],
				parentModel: ctx.model,
				depth: 0,
				signal,
				respawnOnFailure: true,
			}));
		return results;
	} finally {
		call.finishCall({ ok: results.length === tasks.length && results.every((result) => result.ok), error: results.find((result) => !result.ok)?.error });
	}
}

export interface SequenceRetry {
	maxRetries: number;
	retrySteps: Array<{ agent: AgentConfig; task: string }>;
}

export async function dispatchSequence(
	deps: DispatchDeps,
	steps: Array<{ agent: AgentConfig; task: string }>,
	retry?: SequenceRetry,
	signal?: AbortSignal,
	onPlanned?: (snapshot: CallSnapshot) => void,
	launchSurface: LaunchSurface = "foreground",
	onComplete?: (snapshot: CallSnapshot) => void,
): Promise<RunResult> {
	const ctx = deps.getCtx();
	const call = deps.registry.createCall({ mode: "chain", launchSurface, cwd: ctx.cwd, retryConfigured: retry?.maxRetries });
	const terminalCompletion = notifyWhenCallCompletes(deps.registry, call.id, onComplete);
	const personas = createRootPersonas("sequence", steps.map((step) => step.agent));
	const runIds = steps.map((step, index) => call.planRoot(step.agent, step.task, personas[index], { chainStep: index + 1 }));
	onPlanned?.(call.snapshot());
	let previous = "";
	let last: RunResult = { ok: true, finalText: "", usage: emptyUsage(), contextPercent: null };
	try {
		for (let i = 0; i < steps.length; i++) {
		if (signal?.aborted) {
			last = { ok: false, finalText: previous, usage: emptyUsage(), contextPercent: null, error: "aborted" };
			break;
		}
		const taskText = substitutePrevious(steps[i].task, previous);
		call.setTask(runIds[i], taskText);
		last = await runTrackedNode(deps, steps[i].agent, taskText, {
			call,
			runId: runIds[i],
			parentModel: ctx.model,
			depth: 0,
			signal,
		});
		if (!last.ok) break;
		previous = last.finalText;
		}
	// Guaranteed sequence roots were planned up front. If orchestration stops
	// early, materialize their cancellation so the call can become terminal.
	for (const runId of runIds) {
		const record = deps.registry.getRecord(runId);
		if (record?.status === "dormant") {
			call.abandon(runId);
		}
	}

	if (last.ok && retry && retry.maxRetries > 0) {
		for (let attempt = 1; attempt <= retry.maxRetries; attempt++) {
			let retryOk = true;
			for (let index = 0; index < retry.retrySteps.length; index++) {
				const step = retry.retrySteps[index];
				const taskText = substitutePrevious(step.task, previous);
				const persona = createRootPersonas("sequence", [step.agent])[0];
				// Retry nodes are allocated only as an attempt actually begins.
				const runId = call.planRetryRoot(step.agent, taskText, persona, { chainStep: steps.length + index + 1 });
				last = await runTrackedNode(deps, step.agent, taskText, {
					call,
					runId,
					parentModel: ctx.model,
					depth: 0,
					signal,
				});
				previous = last.finalText;
				if (!last.ok) {
					retryOk = false;
					break;
				}
			}
			if (retryOk) break;
		}
	}
	} finally {
		call.finishCall({ ok: last.ok, error: last.error });
	}
	await terminalCompletion;
	return last;
}

// --- the subagent tool ---

const TaskItem = Type.Object({ agent: Type.String({ description: "Agent name" }), task: Type.String({ description: "Task for the agent" }) });
const ChainItem = Type.Object({ agent: Type.String({ description: "Agent name" }), task: Type.String({ description: "Task; may include {previous}" }) });
const RetryConfig = Type.Object({
	maxRetries: Type.Number({ description: "Maximum total attempts for retrySteps (sequence only)." }),
	retrySteps: Type.Array(ChainItem, { description: "Configured steps executed for each retry attempt" }),
}, {
	description: "Optional sequence tail. Executes retrySteps up to maxRetries total attempts, continuing only after an execution failure.",
});

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single mode: the task" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequence mode; {previous} flows" })),
	retry: Type.Optional(RetryConfig),
});

/** Persist exactly the authoritative render-ready snapshot, never mutable rows. */
export function detailsFromSnapshot(snapshot: CallSnapshot): SubagentToolDetailsV2 {
	return {
		schemaVersion: 2,
		revision: snapshot.revision,
		call: snapshot,
	};
}

/** Only fields that change the visible live tree belong in the update key.
 * Token/text streaming stays in the authoritative final snapshot without
 * repeatedly redrawing Pi's transcript. */
function liveNodeSignature(node: RunNodeSnapshot): unknown[] {
	return [
		node.id,
		node.status,
		node.task,
		node.toolLog.filter((entry) => !/^\s*subagent\b/i.test(entry)).length,
		node.children.map(liveNodeSignature),
	];
}

function liveSnapshotSignature(snapshot: CallSnapshot): string {
	return JSON.stringify(snapshot.roots.map(liveNodeSignature));
}

function explicitlyNamesAgent(text: string | undefined, name: string): boolean {
	if (text === undefined) return false;
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^\\p{L}\\p{N}_-])(?:/${escaped}|${escaped})(?=$|[^\\p{L}\\p{N}_-])`, "iu").test(text);
}

export function registerSubagentTool(pi: ExtensionAPI, env: DispatchDeps): void {
	pi.registerTool<typeof Params, SubagentToolDetailsV2 | undefined, SubagentRendererState>({
		name: "subagent",
		label: "Subagent",
		// Deliberately agent-agnostic (like guidance.ts): the routing intelligence lives in
		// the advertised "# Available subagents" block, rebuilt from disk every turn. Naming
		// agents here would go stale on rename/delete.
		description: [
			"Delegate work to specialized subagents that run with their own isolated context and return only a summary.",
			"The advertised agents and proactive routing rules are listed under '# Available subagents'; an agent explicitly named by the user may be invoked even when absent from that roster.",
			"Modes: single { agent, task }; parallel { tasks:[…] }; sequence { chain:[…] } (sequential, {previous} passes the prior step's output forward).",
			"Add retry to a sequence to execute configured retrySteps up to maxRetries total attempts, continuing only after an execution failure.",
		].join(" "),
		promptSnippet: "Delegate focused tasks to advertised subagents with isolated context. Explicit user naming permits a hidden agent without advertising hidden identities. Use a sequence only for genuinely separate specialist stages; retrySteps rerun only after execution failure.",
		promptGuidelines: [
			"Choose a proactive subagent by the descriptions under '# Available subagents'; an explicitly user-named subagent may be invoked even if auto:false.",
			"Use one parallel subagent call when 2+ justified tasks are independent; do not manufacture parallelism, duplicate work, pair implementation with review/verification, or overlap writers.",
			"Use subagent sequence mode + {previous} only for separate specialist stages; parallel mode is for independent work.",
			"A subagent retry reruns retrySteps only after execution failure; it does not interpret review verdicts or promise a clean result.",
			"A subagent returns only its final summary; ask for concise file:line evidence, not code dumps.",
		],
		parameters: Params,
		renderShell: "self",

		async execute(_id, params, signal, onUpdate, ctx) {
			const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
			const byName = (n: string) => agents.find((a) => a.name === n);
			const automaticNames = agents.filter((agent) => agent.auto).map((agent) => agent.name);
			const requestedNames = [params.agent, ...(params.tasks ?? []).map((item) => item.agent), ...(params.chain ?? []).map((item) => item.agent), ...(params.retry?.retrySteps ?? []).map((item) => item.agent)].filter((name): name is string => typeof name === "string");
			const userText = env.currentUserPrompt?.();
			const blockedManual = requestedNames.find((name) => {
				const agent = byName(name);
				return agent !== undefined && !agent.auto && !explicitlyNamesAgent(userText, agent.name);
			});
			if (blockedManual) {
				const available = automaticNames.join(", ") || "none";
				return { content: [{ type: "text", text: `That agent is not available for automatic routing. Available: ${available}` }], details: undefined, isError: true };
			}
			const modes = [Boolean(params.agent && params.task), (params.tasks?.length ?? 0) > 0, (params.chain?.length ?? 0) > 0].filter(Boolean).length;
			if (modes !== 1) {
				const list = automaticNames.join(", ") || "none";
				return { content: [{ type: "text", text: `Provide exactly one of single {agent,task}, parallel {tasks}, or sequence {chain}. Available: ${list}` }], details: undefined };
			}
			let latest: CallSnapshot | undefined;
			let publishedSignature: string | undefined;
			const details = (): SubagentToolDetailsV2 | undefined =>
				latest ? detailsFromSnapshot(latest) : undefined;
			const planned = (snapshot: CallSnapshot) => {
				latest = snapshot;
			};
			const unsubscribe = env.registry.onChange(() => {
				if (!latest) return;
				const next = env.registry.getCallSnapshot(latest.id);
				if (next.revision === latest.revision) return;
				latest = next;
				// The terminal result immediately replaces the final partial state.
				if (next.counts.active === 0 && next.counts.dormant === 0) return;
				const signature = liveSnapshotSignature(next);
				if (signature === publishedSignature) return;
				// Expanded rows can be tall enough to disturb terminal scroll. Always
				// publish the first real state, then hold later activity until collapsed.
				if (publishedSignature !== undefined && ctx.ui?.getToolsExpanded?.()) return;
				publishedSignature = signature;
				onUpdate?.({
					content: [{ type: "text", text: "Subagent running..." }],
					details: detailsFromSnapshot(next),
				});
			});

			try {
				if (params.agent && params.task) {
				const agent = byName(params.agent);
				if (!agent) return { content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${automaticNames.join(", ") || "none"}` }], details: undefined, isError: true };
					const result = await dispatchSingle(env, agent, params.task, undefined, { signal, onPlanned: planned });
					return { content: [{ type: "text", text: result.ok ? cap(result.finalText) : cap(`Agent failed: ${result.error ?? result.finalText}`) }], details: details(), isError: !result.ok };
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL) return { content: [{ type: "text", text: `Too many parallel tasks (max ${MAX_PARALLEL}).` }], details: undefined, isError: true };
				const unknown = params.tasks.find((t) => !byName(t.agent));
				if (unknown) return { content: [{ type: "text", text: `Unknown agent "${unknown.agent}".` }], details: undefined, isError: true };
					const requests = params.tasks.map((task) => ({ agent: byName(task.agent)!, task: task.task }));
					const results = await dispatchParallel(env, requests, signal, planned);
				const ok = results.filter((r) => r.ok).length;
					return { content: [{ type: "text", text: formatParallelResult(params.tasks.map((task) => task.agent), results) }], details: details(), isError: ok === 0 };
			}

			if (params.chain && params.chain.length > 0) {
				const unknown = params.chain.find((s) => !byName(s.agent));
				if (unknown) return { content: [{ type: "text", text: `Unknown agent "${unknown.agent}".` }], details: undefined, isError: true };
				if (params.retry) {
						const unknownRetry = params.retry.retrySteps.find((s) => !byName(s.agent));
						if (unknownRetry) return { content: [{ type: "text", text: `Unknown agent in retrySteps "${unknownRetry.agent}".` }], details: undefined, isError: true };
				}
					const steps = params.chain.map((step) => ({ agent: byName(step.agent)!, task: step.task }));
					const retry = params.retry ? {
						maxRetries: params.retry.maxRetries,
						retrySteps: params.retry.retrySteps.map((step) => ({ agent: byName(step.agent)!, task: step.task })),
					} : undefined;
					const result = await dispatchSequence(env, steps, retry, signal, planned);
					if (!result.ok) {
						const failedRoot = latest?.roots.find((root) => root.status === "error");
						const mainIndex = failedRoot ? latest?.roots.indexOf(failedRoot) ?? -1 : -1;
						if (mainIndex >= 0 && mainIndex < params.chain.length) {
							const step = params.chain[mainIndex];
							return { content: [{ type: "text", text: cap(`Sequence stopped at step ${mainIndex + 1} (${step.agent}): ${result.error ?? result.finalText}`) }], details: details(), isError: true };
						}
						return {
							content: [{ type: "text", text: cap(`Retry loop exhausted after ${params.retry?.maxRetries ?? 0} attempt(s). Last output:\n\n${result.finalText || "(no output)"}`) }],
							details: details(),
							isError: true,
						};
					}
					return { content: [{ type: "text", text: cap(result.finalText || "(no output)") }], details: details() };
			}
			return { content: [{ type: "text", text: "No mode selected." }], details: undefined, isError: true };
			} finally {
				unsubscribe();
			}
		},

		renderCall: (args, theme, context) => {
			context.state.getShowCosts = env.showCosts;
			context.state.showCosts = env.showCosts?.() ?? false;
			return renderSubagentCall(args, theme, context);
		},
		renderResult: (result, options, theme, context) => {
			context.state.getShowCosts = env.showCosts;
			context.state.showCosts = env.showCosts?.() ?? false;
			context.state.now = Date.now;
			context.state.invalidate = context.invalidate;
			const details = normalizeV2Details(result.details);
			const hasActiveRows = details !== undefined && details.call.counts.active > 0;
			if (options.isPartial && hasActiveRows && !context.state.stopClock) {
				context.state.stopClock = env.liveSurface?.subscribeRenderer(() => context.state.invalidate?.());
			} else if ((!options.isPartial || !hasActiveRows) && context.state.stopClock) {
				context.state.stopClock();
				context.state.stopClock = undefined;
			}
			return renderSubagentResult(result, options, theme, context);
		},
	});
}
