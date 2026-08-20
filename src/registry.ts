import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { emptyUsage, type RunEvent, type RunHandle, type RunResult, type RunUsage } from "./engine.ts";
import type { PersonaDescriptor } from "./persona.ts";

export type CallId = number;
export type RunId = number;
export type RunNodeStatus = "dormant" | "active" | "success" | "error" | "aborted";
export type RunMode = "single" | "parallel" | "chain";
export type LaunchSurface = "foreground" | "background";

const TOOL_LOG_CAP = 200;
export const RESULT_CAP_BYTES = 50 * 1024;
export const RESULT_TRUNCATION_MARKER = `[truncated at ${RESULT_CAP_BYTES / 1024}KB — the agent returned too much; ask it a narrower question]`;

export interface RunActivity {
	type: "planned" | "started" | "status" | "tool" | "text" | "usage" | "finished";
	at: number;
	text?: string;
	tool?: string;
}

/**
 * The mutable authoritative node. Compatibility consumers may read these
 * records, but lifecycle mutation stays on CallHandle/RunRegistry.
 */
export interface RunRecord {
	id: RunId;
	callId: CallId;
	parentId?: RunId;
	agentName: string;
	role: string;
	persona: PersonaDescriptor;
	color: string;
	task: string;
	status: RunNodeStatus;
	plannedAt: number;
	startedAt?: number;
	endedAt?: number;
	usage: RunUsage;
	model?: string;
	contextPercent: number | null;
	activity: RunActivity;
	lastConcreteTool?: string;
	lastText?: string;
	toolLog: string[];
	finalText?: string;
	structuredResult?: import("./result-view.ts").StructuredResultDescriptor;
	error?: string;
	cwd?: string;
	mode: RunMode;
	chainStep?: number;
	handle?: RunHandle;
	abortRequested?: boolean;
	historyEligible?: boolean;
	historyEmitted?: boolean;
	children: RunRecord[];
}

export interface RunNodeSnapshot {
	id: RunId;
	callId: CallId;
	parentId?: RunId;
	role: string;
	persona: PersonaDescriptor;
	color: string;
	task: string;
	status: RunNodeStatus;
	plannedAt: number;
	startedAt?: number;
	finishedAt?: number;
	durationMs: number;
	usage: RunUsage;
	model?: string;
	contextPercent: number | null;
	activity: RunActivity;
	toolLog: string[];
	finalText?: string;
	structuredResult?: import("./result-view.ts").StructuredResultDescriptor;
	error?: string;
	ownCost: number;
	subtreeCost: number;
	children: RunNodeSnapshot[];
}

export interface CallCounts {
	total: number;
	dormant: number;
	active: number;
	finished: number;
	failed: number;
}

export const SUBAGENT_ACTIVITY_CHANNEL = "subagents:activity";
export const SUBAGENT_ACTIVITY_SCHEMA_VERSION = 1;

export type SubagentActivityEvent =
	| { schemaVersion: 1; type: "snapshot"; snapshot: CallSnapshot }
	| { schemaVersion: 1; type: "removed"; callId: CallId };

export interface CallSnapshot {
	id: CallId;
	mode: RunMode;
	launchSurface: LaunchSurface;
	/** Monotonic real-lifecycle revision; reading/rendering a snapshot never advances it. */
	revision: number;
	createdAt: number;
	finishedAt?: number;
	durationMs: number;
	counts: CallCounts;
	totalCost: number;
	roots: RunNodeSnapshot[];
	retryConfigured?: number;
	ok?: boolean;
	error?: string;
}

export interface CreateCallOptions {
	mode: RunMode;
	launchSurface?: LaunchSurface;
	cwd?: string;
	retryConfigured?: number;
}

export interface CallFinishResult {
	ok: boolean;
	error?: string;
}

export interface CallHandle {
	readonly id: CallId;
	planRoot(agent: AgentConfig, task: string, persona: PersonaDescriptor, options?: { chainStep?: number }): RunId;
	planRetryRoot(agent: AgentConfig, task: string, persona: PersonaDescriptor, options?: { chainStep?: number }): RunId;
	spawnChild(parentRunId: RunId, agent: AgentConfig, task: string, persona: PersonaDescriptor): RunId;
	setTask(runId: RunId, task: string): void;
	start(runId: RunId): void;
	attachHandle(runId: RunId, handle: RunHandle): void;
	applyEvent(runId: RunId, event: RunEvent): void;
	finish(runId: RunId, result: RunResult): void;
	/** Terminalize guaranteed work that orchestration never executed, without historical root side effects. */
	abandon(runId: RunId): void;
	finishCall(result: CallFinishResult): void;
	snapshot(now?: number): CallSnapshot;
}

interface CallState {
	id: CallId;
	options: CreateCallOptions;
	createdAt: number;
	finishedAt?: number;
	roots: RunRecord[];
	revision: number;
	orchestrationEnded: boolean;
	finishResult?: CallFinishResult;
	finishEmitted: boolean;
}

function cloneUsage(usage: RunUsage): RunUsage {
	return { ...usage };
}

function terminal(status: RunNodeStatus): boolean {
	return status === "success" || status === "error" || status === "aborted";
}

export function capResult(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= RESULT_CAP_BYTES) return text;
	const suffix = `\n${RESULT_TRUNCATION_MARKER}`;
	const bodyCap = RESULT_CAP_BYTES - Buffer.byteLength(suffix, "utf8");
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= bodyCap) low = middle;
		else high = middle - 1;
	}
	// Never split a valid surrogate pair at the truncation boundary.
	if (low > 0 && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1]) && /[\uDC00-\uDFFF]/.test(text[low])) low--;
	return text.slice(0, low) + suffix;
}

/** One state owner for every invocation and every nested run in that invocation. */
export class RunRegistry {
	private readonly calls: CallState[] = [];
	private readonly records = new Map<RunId, RunRecord>();
	private readonly listeners = new Set<() => void>();
	private readonly finishListeners = new Set<(record: RunRecord) => void>();
	private readonly callFinishListeners = new Set<(snapshot: CallSnapshot) => void>();
	private nextCallId = 1;
	private nextRunId = 1;
	private readonly now: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	createCall(options: CreateCallOptions): CallHandle {
		const call: CallState = {
			id: this.nextCallId++,
			options,
			createdAt: this.now(),
			roots: [],
			revision: 0,
			orchestrationEnded: false,
			finishEmitted: false,
		};
		this.calls.push(call);
		this.notify();

		const plan = (agent: AgentConfig, task: string, persona: PersonaDescriptor, planOptions?: { chainStep?: number }): RunId => {
			const record = this.createRecord(call, undefined, agent, task, persona, planOptions?.chainStep);
			call.roots.push(record);
			this.changed(call);
			return record.id;
		};

		return {
			id: call.id,
			planRoot: plan,
			planRetryRoot: plan,
			spawnChild: (parentRunId, agent, task, persona) => {
				const parent = this.recordForCall(call, parentRunId);
				const record = this.createRecord(call, parent.id, agent, task, persona);
				parent.children.push(record);
				this.changed(call);
				return record.id;
			},
			setTask: (runId, task) => {
				const record = this.recordForCall(call, runId);
				if (record.status !== "dormant") return;
				record.task = task;
				this.changed(call);
			},
			start: (runId) => this.start(call, runId),
			attachHandle: (runId, handle) => this.attachHandle(call, runId, handle),
			applyEvent: (runId, event) => this.applyEventToCall(call, runId, event),
			finish: (runId, result) => this.finishInCall(call, runId, result),
			abandon: (runId) => this.finishInCall(
				call,
				runId,
				{ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "aborted" },
				false,
			),
			finishCall: (result) => {
				if (!call.orchestrationEnded) {
					call.orchestrationEnded = true;
					call.finishResult = {
						...result,
						error: result.error === undefined ? undefined : capResult(result.error),
					};
				}
				this.maybeFinishCall(call);
			},
			snapshot: (now = this.now()) => this.snapshotCall(call, now),
		};
	}

	getCallSnapshot(callId: CallId, now = this.now()): CallSnapshot {
		return this.snapshotCall(this.requireCall(callId), now);
	}

	activeCallSnapshots(now = this.now()): CallSnapshot[] {
		return this.calls.filter((call) => call.finishedAt === undefined).map((call) => this.snapshotCall(call, now));
	}

	getRecord(runId: RunId): RunRecord | undefined {
		return this.records.get(runId);
	}

	running(): RunRecord[] {
		// Compatibility consumers treat this as one row/action per root invocation;
		// stopping a root recursively reaches its active descendants.
		return [...this.records.values()].filter(
			(record) => record.parentId === undefined && record.status === "active",
		);
	}

	hasActive(): boolean {
		return this.running().length > 0;
	}

	/** True while any node in the call graph is active, including descendants
	 * whose terminal root no longer appears in the compatibility root list. */
	hasActiveNode(): boolean {
		return [...this.records.values()].some((record) => record.status === "active");
	}

	stop(record: RunRecord): void {
		const call = this.requireCall(record.callId);
		if (record.status === "dormant") {
			this.finishInCall(
				call,
				record.id,
				{ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "aborted" },
				false,
			);
			return;
		}
		const active = [...this.walk([record])].filter((node) => node.status === "active" && !node.abortRequested);
		// Mark the whole allocated branch before invoking any handle: an abort may
		// settle synchronously, and root history must still wait for descendants.
		for (const node of active) {
			node.abortRequested = true;
			node.activity = { type: "status", at: this.now(), text: "aborting" };
		}
		for (const node of active) node.handle?.abort();
		this.maybeFinishCall(call);
		this.changed(call);
	}

	elapsedMs(record: RunRecord): number {
		if (record.startedAt === undefined) return 0;
		return (record.endedAt ?? this.now()) - record.startedAt;
	}

	totalCost(): number {
		let total = 0;
		for (const record of this.records.values()) total += record.usage.cost;
		return total;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Compatibility hook: root records only, preserving one runs.jsonl entry per root. */
	onFinish(listener: (record: RunRecord) => void): () => void {
		this.finishListeners.add(listener);
		return () => this.finishListeners.delete(listener);
	}

	onCallFinish(listener: (snapshot: CallSnapshot) => void): () => void {
		this.callFinishListeners.add(listener);
		return () => this.callFinishListeners.delete(listener);
	}

	publishActivityTo(eventBus: EventBus): () => void {
		const publishSnapshots = () => {
			for (const snapshot of this.activeCallSnapshots()) {
				eventBus.emit(SUBAGENT_ACTIVITY_CHANNEL, {
					schemaVersion: SUBAGENT_ACTIVITY_SCHEMA_VERSION,
					type: "snapshot",
					snapshot: structuredClone(snapshot),
				} satisfies SubagentActivityEvent);
			}
		};
		const offChange = this.onChange(publishSnapshots);
		const offFinish = this.onCallFinish((snapshot) => eventBus.emit(SUBAGENT_ACTIVITY_CHANNEL, {
			schemaVersion: SUBAGENT_ACTIVITY_SCHEMA_VERSION,
			type: "removed",
			callId: snapshot.id,
		} satisfies SubagentActivityEvent));
		return () => { offChange(); offFinish(); };
	}

	private createRecord(
		call: CallState,
		parentId: RunId | undefined,
		agent: AgentConfig,
		task: string,
		persona: PersonaDescriptor,
		chainStep?: number,
	): RunRecord {
		if (process.env.SUBAGENT_ROUTING_EVAL === "1") console.error(`SUBAGENT_EVAL_SPAWN ${agent.name}`);
		const plannedAt = this.now();
		const record: RunRecord = {
			id: this.nextRunId++,
			callId: call.id,
			parentId,
			agentName: agent.name,
			role: agent.name,
			persona: { ...persona },
			color: agent.color,
			task,
			status: "dormant",
			plannedAt,
			usage: emptyUsage(),
			contextPercent: null,
			activity: { type: "planned", at: plannedAt },
			toolLog: [],
			cwd: call.options.cwd,
			mode: call.options.mode,
			chainStep,
			children: [],
		};
		this.records.set(record.id, record);
		return record;
	}

	private start(call: CallState, runId: RunId): void {
		const record = this.recordForCall(call, runId);
		if (record.status !== "dormant") return;
		record.status = "active";
		record.startedAt = this.now();
		record.activity = { type: "started", at: record.startedAt };
		this.changed(call);
	}

	private attachHandle(call: CallState, runId: RunId, handle: RunHandle): void {
		const record = this.recordForCall(call, runId);
		if (terminal(record.status)) {
			handle.abort();
			return;
		}
		record.handle = handle;
		if (record.abortRequested) handle.abort();
	}

	private applyEventToCall(call: CallState, runId: RunId, event: RunEvent): void {
		const record = this.recordForCall(call, runId);
		if (terminal(record.status)) return;
		const at = this.now();
		switch (event.type) {
			case "status":
				record.activity = { type: "status", at, text: event.status };
				break;
			case "tool":
				if (event.name !== "subagent") record.lastConcreteTool = event.name;
				record.toolLog.push(event.argsPreview);
				if (record.toolLog.length > TOOL_LOG_CAP) record.toolLog.splice(0, record.toolLog.length - TOOL_LOG_CAP);
				record.activity = { type: "tool", at, tool: event.name, text: event.argsPreview };
				break;
			case "text":
				record.lastText = event.text.split("\n").find((line) => line.trim()) ?? record.lastText;
				record.activity = { type: "text", at, text: record.lastText };
				break;
			case "usage":
				record.usage = cloneUsage(event.usage);
				record.contextPercent = event.contextPercent;
				record.activity = { type: "usage", at };
				break;
		}
		this.changed(call);
	}

	private finishInCall(call: CallState, runId: RunId, result: RunResult, emitRootFinish = true): void {
		const record = this.recordForCall(call, runId);
		if (terminal(record.status)) return;
		if (record.status === "dormant") this.start(call, runId);
		const at = this.now();
		record.status = record.abortRequested || result.error === "aborted" ? "aborted" : result.ok ? "success" : "error";
		record.usage = cloneUsage(result.usage);
		record.contextPercent = result.contextPercent;
		record.model = result.model;
		record.finalText = capResult(result.finalText);
		record.structuredResult = result.structuredResult === undefined ? undefined : structuredClone(result.structuredResult);
		record.error = record.status === "aborted" ? "aborted" : result.ok ? undefined : capResult(result.error ?? result.finalText);
		record.endedAt = at;
		record.activity = { type: "finished", at, text: record.error ?? record.finalText, tool: record.lastConcreteTool };
		record.handle = undefined;
		if (record.parentId === undefined) record.historyEligible = emitRootFinish;
		this.changed(call);
		this.maybeEmitRootHistory(call);
		this.maybeFinishCall(call);
	}

	private maybeEmitRootHistory(call: CallState): void {
		for (const root of call.roots) {
			if (!root.historyEligible || root.historyEmitted || !terminal(root.status)) continue;
			if ([...this.walk(root.children)].some((node) => !terminal(node.status))) continue;
			root.historyEmitted = true;
			for (const listener of this.finishListeners) listener(root);
		}
	}

	private maybeFinishCall(call: CallState): void {
		if (!call.orchestrationEnded || call.finishEmitted) return;
		if ([...this.walk(call.roots)].some((record) => !terminal(record.status))) return;
		call.finishEmitted = true;
		call.finishedAt = this.now();
		this.changed(call);
		const snapshot = this.snapshotCall(call, call.finishedAt);
		for (const listener of this.callFinishListeners) listener(snapshot);
	}

	private snapshotCall(call: CallState, now: number): CallSnapshot {
		const roots = call.roots.map((record) => this.snapshotNode(record, now));
		const all = [...this.walk(call.roots)];
		const counts: CallCounts = {
			total: all.length,
			dormant: all.filter((record) => record.status === "dormant").length,
			active: all.filter((record) => record.status === "active").length,
			finished: all.filter((record) => terminal(record.status)).length,
			failed: all.filter((record) => record.status === "error" || record.status === "aborted").length,
		};
		return {
			id: call.id,
			mode: call.options.mode,
			launchSurface: call.options.launchSurface ?? "foreground",
			revision: call.revision,
			createdAt: call.createdAt,
			finishedAt: call.finishedAt,
			durationMs: (call.finishedAt ?? now) - call.createdAt,
			counts,
			totalCost: roots.reduce((sum, root) => sum + root.subtreeCost, 0),
			roots,
			retryConfigured: call.options.retryConfigured,
			ok: call.finishResult?.ok,
			error: call.finishResult?.error,
		};
	}

	private snapshotNode(record: RunRecord, now: number): RunNodeSnapshot {
		const children = record.children.map((child) => this.snapshotNode(child, now));
		const ownCost = record.usage.cost;
		return {
			id: record.id,
			callId: record.callId,
			parentId: record.parentId,
			role: record.role,
			persona: { ...record.persona },
			color: record.color,
			task: record.task,
			status: record.status,
			plannedAt: record.plannedAt,
			startedAt: record.startedAt,
			finishedAt: record.endedAt,
			durationMs: record.startedAt === undefined ? 0 : (record.endedAt ?? now) - record.startedAt,
			usage: cloneUsage(record.usage),
			model: record.model,
			contextPercent: record.contextPercent,
			// Usage/text/status events may arrive after a tool event. Preserve the last
			// concrete tool for the live/final task line instead of making activity
			// blink blank between calls.
			activity: { ...record.activity, tool: record.activity.tool ?? record.lastConcreteTool },
			toolLog: [...record.toolLog],
			finalText: record.finalText,
			structuredResult: record.structuredResult === undefined ? undefined : structuredClone(record.structuredResult),
			error: record.error,
			ownCost,
			subtreeCost: ownCost + children.reduce((sum, child) => sum + child.subtreeCost, 0),
			children,
		};
	}

	private *walk(roots: readonly RunRecord[]): Iterable<RunRecord> {
		for (const root of roots) {
			yield root;
			yield* this.walk(root.children);
		}
	}

	private recordForCall(call: CallState, runId: RunId): RunRecord {
		const record = this.records.get(runId);
		if (!record || record.callId !== call.id) throw new Error(`Unknown run ${runId} for call ${call.id}`);
		return record;
	}

	private requireCall(callId: CallId): CallState {
		const call = this.calls.find((candidate) => candidate.id === callId);
		if (!call) throw new Error(`Unknown call ${callId}`);
		return call;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	/** Record one serializable snapshot revision for genuine activity in this call. */
	private changed(call: CallState): void {
		call.revision += 1;
		this.notify();
	}
}
