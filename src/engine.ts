import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfig } from "./agents.ts";
import { resolveChildToolNames } from "./agents.ts";
import { gitInspectToolForAgent } from "./git-inspect.ts";

/** How deep a spawn chain may nest (worker → scout → … ) before delegation is refused. */
export const MAX_SPAWN_DEPTH = 3;
/** Match the root tool's bounded parallel fan-out without coupling engine.ts back to tool.ts. */
export const MAX_NESTED_PARALLEL = 10;

/** Default guards so a hung or looping child can never block forever / burn unbounded tokens. */
export const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_TURNS = 120;

/** Lets a child agent delegate to the agents named in its `spawn:` list. */
export interface SpawnContext {
	depth: number;
	resolveAgent: (name: string) => AgentConfig | undefined;
	runChild(request: {
		agent: AgentConfig;
		task: string;
		parentModel: Model<any>;
		depth: number;
		signal?: AbortSignal;
		/** Parallel branches are leaves: they cannot fan out into writable descendants. */
		allowSpawn: boolean;
		/** Logical parallel branches get one immediate respawn after ordinary failure. */
		respawnOnFailure?: boolean;
	}): Promise<RunResult>;
}

export type RunStatus = "pending" | "running" | "done" | "error" | "aborted";

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	contextTokens: number;
}

export type RunEvent =
	| { type: "status"; status: RunStatus }
	| { type: "tool"; name: string; argsPreview: string }
	| { type: "text"; text: string }
	| { type: "usage"; usage: RunUsage; contextPercent: number | null };

export interface RunResult {
	ok: boolean;
	finalText: string;
	usage: RunUsage;
	contextPercent: number | null;
	/** The actual provider/model used by the final attempt. */
	model?: string;
	error?: string;
	/** TUI-only structured presentation; finalText remains canonical. */
	structuredResult?: import("./result-view.ts").StructuredResultDescriptor;
}

export interface RunHandle {
	promise: Promise<RunResult>;
	abort(): void;
}

export function emptyUsage(): RunUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		toolCalls: 0,
		contextTokens: 0,
	};
}

/** Collect AGENTS.md conventions for a forked child: the global one (~/.pi/agent) plus every
 * AGENTS.md from the filesystem root down to cwd (nearest wins, appended last). CLAUDE.md and
 * the rest of pi's context stack are deliberately excluded. */
function collectAgentsMd(cwd: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (file: string) => {
		try {
			const real = fs.realpathSync(file);
			if (seen.has(real)) return;
			const txt = fs.readFileSync(file, "utf-8").trim();
			if (txt) {
				seen.add(real);
				out.push(`# Project conventions (${file})\n${txt}`);
			}
		} catch {
			/* missing/unreadable → skip */
		}
	};
	add(path.join(getAgentDir(), "AGENTS.md")); // global, least specific
	const dirs: string[] = [];
	let cur = cwd;
	while (true) {
		dirs.unshift(cur);
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	for (const dir of dirs) add(path.join(dir, "AGENTS.md")); // root → cwd, nearest last
	return out;
}

/** Match a model pattern against the registry. Supports "provider/id", bare "id", or substring. */
export function resolveModel(registry: ModelRegistry, pattern: string | undefined): Model<any> | undefined {
	if (!pattern) return undefined;
	const all = registry.getAll();
	if (pattern.includes("/")) {
		const [p, id] = pattern.split("/", 2);
		const exact = registry.find(p, id);
		if (exact) return exact;
	}
	const byId = all.find((m: any) => m.id === pattern);
	if (byId) return byId;
	return all.find((m: any) => `${m.provider}/${m.id}`.includes(pattern) || m.id.includes(pattern));
}

export function resolveAgentModel(registry: ModelRegistry, agent: AgentConfig, parentModel: Model<any> | undefined): Model<any> | undefined {
	return agent.model ? resolveModel(registry, agent.model) : parentModel;
}

/**
 * Build the isolated SDK session used by a child run.
 *
 * ModelRegistry remains an extension-facing selection facade; authentication
 * and request streaming belong to the ModelRuntime that createAgentSession()
 * constructs from Pi's configured agent directory.
 */
export async function createChildSession(args: {
	agent: AgentConfig;
	model: Model<any>;
	cwd: string;
	conventions: boolean;
	canSpawn: boolean;
	customTools: ToolDefinition[];
}): Promise<AgentSession> {
	const conventions = args.conventions ? collectAgentsMd(args.cwd) : [];
	const loader = new DefaultResourceLoader({
		cwd: args.cwd,
		agentDir: getAgentDir(),
		settingsManager: SettingsManager.create(args.cwd, getAgentDir()),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPrompt: conventions.length > 0 ? conventions : undefined,
		systemPrompt: args.agent.systemPrompt || undefined,
	});
	await loader.reload();

	const toolCfg = resolveChildToolNames(args.agent, args.canSpawn);
	const { session } = await createAgentSession({
		cwd: args.cwd,
		model: args.model,
		thinkingLevel: args.agent.thinking as any,
		tools: toolCfg.tools,
		noTools: toolCfg.noTools,
		customTools: args.customTools.length > 0 ? args.customTools : undefined,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(args.cwd),
	});
	return session;
}

function argsPreview(name: string, args: any): string {
	try {
		if (name === "bash") return `$ ${String(args?.command ?? "").slice(0, 60)}`;
		if (name === "read" || name === "edit" || name === "write")
			return `${name} ${args?.file_path ?? args?.path ?? ""}`;
		if (name === "grep") return `grep /${args?.pattern ?? ""}/`;
		if (name === "find") return `find ${args?.pattern ?? ""}`;
		const s = JSON.stringify(args ?? {});
		return `${name} ${s.length > 50 ? `${s.slice(0, 50)}…` : s}`;
	} catch {
		return name;
	}
}

/**
 * Build the child's scoped delegation tool. Execution itself is supplied by
 * tool.ts so nested runs use the same authoritative registry, fallback, and
 * structured-return path as roots.
 */
export function createSpawnTool(args: {
	agent: AgentConfig;
	model: Model<any>;
	signal?: AbortSignal;
	spawn?: SpawnContext;
}): ToolDefinition | undefined {
	const spawn = args.spawn;
	if (!spawn || args.agent.spawn.length === 0 || spawn.depth >= MAX_SPAWN_DEPTH) return undefined;
	// Nested selection is always automatic: manual agents are neither selectable nor leaked.
	const allow = args.agent.spawn.filter((name) => spawn.resolveAgent(name)?.auto === true);
	if (allow.length === 0) return undefined;
	const TaskItem = Type.Object({
		agent: Type.String({ description: `One of: ${allow.join(", ")}` }),
		task: Type.String({ description: "The task for the subagent" }),
	});
	const error = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });
	return {
		name: "subagent",
		label: "Subagent",
		description: `Delegate focused work to allowed subagents. Use single {agent,task}, or parallel {tasks:[…]} only when every target is read-only and the work is independent. Allowed: ${allow.join(", ")}.`,
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Single mode agent" })),
			task: Type.Optional(Type.String({ description: "Single mode task" })),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel read-only work", maxItems: MAX_NESTED_PARALLEL })),
		}),
		async execute(_id, params: { agent?: string; task?: string; tasks?: Array<{ agent: string; task: string }> }, signal) {
			const single = typeof params.agent === "string" && typeof params.task === "string";
			const parallel = Array.isArray(params.tasks) && params.tasks.length > 0;
			if (Number(single) + Number(parallel) !== 1 || (single && params.tasks !== undefined) || (!single && (params.agent !== undefined || params.task !== undefined))) {
				return error("Provide exactly one of single {agent,task} or parallel {tasks}.");
			}
			const requests = single ? [{ agent: params.agent!, task: params.task! }] : params.tasks!;
			if (requests.length > MAX_NESTED_PARALLEL) return error(`Parallel delegation accepts at most ${MAX_NESTED_PARALLEL} tasks.`);
			const resolved: Array<{ agent: AgentConfig; task: string }> = [];
			for (const request of requests) {
				if (!allow.includes(request.agent)) return error(`Not allowed to delegate to "${request.agent}". Allowed: ${allow.join(", ")}`);
				const child = spawn.resolveAgent(request.agent);
				if (!child) return error(`Unknown agent "${request.agent}".`);
				resolved.push({ agent: child, task: request.task });
			}
			if (parallel && resolved.some(({ agent }) => !agent.readonly)) {
				return error("Nested parallel delegation is allowed only when every target agent is read-only. Use single or sequential calls for writable agents.");
			}
			const results = await Promise.all(resolved.map(({ agent, task }) => spawn.runChild({
				agent,
				task,
				parentModel: args.model,
				depth: spawn.depth + 1,
				signal: signal ?? args.signal,
				// Immediate targets are read-only, and disabling their spawn tool closes
				// the transitive path to concurrent writable descendants.
				allowSpawn: !parallel,
				respawnOnFailure: parallel,
			})));
			const failed = results.some((result) => !result.ok);
			const text = parallel
				? results.map((result, index) => `[${resolved[index].agent.name}] ${result.ok ? result.finalText : `failed: ${result.error ?? result.finalText}`}`).join("\n\n")
				: results[0].ok ? results[0].finalText : `Subagent ${resolved[0].agent.name} failed: ${results[0].error ?? results[0].finalText}`;
			return { content: [{ type: "text", text }], details: undefined, isError: failed };
		},
	};
}

export async function runAgent(args: {
	agent: AgentConfig;
	task: string;
	parentModel: Model<any> | undefined;
	registry: ModelRegistry;
	cwd: string;
	conventions: boolean;
	signal?: AbortSignal;
	spawn?: SpawnContext;
	/** Idle cap: the child is aborted after this long with no tool call or assistant
	 * turn (the timer resets on activity, so long-but-busy runs survive). Default DEFAULT_RUN_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Max assistant turns before the child is aborted. Default DEFAULT_MAX_TURNS. */
	maxTurns?: number;
	/** Optional final-output check (structured returns). Return null when valid, or a
	 * repair message; the session gets one extra prompt to fix its output. */
	validate?: (finalText: string) => string | null;
	onEvent: (e: RunEvent) => void;
}): Promise<RunHandle> {
	const { agent, registry, cwd, onEvent } = args;
	const model = resolveAgentModel(registry, agent, args.parentModel);

	// Fast-fail guards: never hang on an already-aborted run or a missing model.
	if (args.signal?.aborted) {
		return {
			promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, model: model ? `${model.provider}/${model.id}` : undefined, error: "aborted" }),
			abort: () => {},
		};
	}
	if (!model) {
		const err = `No model available for agent "${agent.name}" (pattern: ${agent.model ?? "inherit"})`;
		onEvent({ type: "status", status: "error" });
		return {
			promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: err }),
			abort: () => {},
		};
	}

	// Custom tools are opt-in: scoped delegation comes from `spawn:`, while the
	// fixed Git inspection surface must be named explicitly in agent frontmatter.
	const spawnTool = createSpawnTool({ agent, model, signal: args.signal, spawn: args.spawn });
	const gitInspectTool = gitInspectToolForAgent(agent, cwd);
	const customTools: ToolDefinition[] = [
		...(spawnTool ? [spawnTool] : []),
		...(gitInspectTool ? [gitInspectTool] : []),
	];
	const canSpawn = spawnTool !== undefined;

	// Child sees only its own prompt and the explicitly inherited AGENTS.md
	// conventions; createChildSession keeps the SDK compatibility boundary in
	// one place without changing the surrounding run lifecycle.
	const session = await createChildSession({
		agent,
		model,
		cwd,
		conventions: args.conventions,
		canSpawn,
		customTools,
	});

	const usage = emptyUsage();
	const recomputeContext = (): number | null => {
		const cu = session.getContextUsage();
		if (cu?.tokens != null) usage.contextTokens = cu.tokens;
		return cu?.percent ?? null;
	};

	// Stop reason: external abort, wall-clock timeout, or turn-cap. All abort the session.
	let stopReason: "aborted" | "timeout" | "turnlimit" | null = null;
	const stop = (reason: "aborted" | "timeout" | "turnlimit") => {
		if (!stopReason) stopReason = reason;
		void session.abort();
	};
	const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS;

	const unsubscribe = session.subscribe((e) => {
		switch (e.type) {
			case "agent_start":
				onEvent({ type: "status", status: "running" });
				break;
			case "tool_execution_start":
				usage.toolCalls += 1;
				onEvent({ type: "tool", name: e.toolName, argsPreview: argsPreview(e.toolName, e.args) });
				resetIdle();
				break;
			case "message_end": {
				const msg: any = e.message;
				if (msg?.role === "assistant") {
					usage.turns += 1;
					if (usage.turns >= maxTurns) stop("turnlimit");
					const u = msg.usage;
					if (u) {
						usage.input += u.input || 0;
						usage.output += u.output || 0;
						usage.cacheRead += u.cacheRead || 0;
						usage.cacheWrite += u.cacheWrite || 0;
						usage.cost += u.cost?.total || 0;
						if (u.totalTokens) usage.contextTokens = u.totalTokens;
					}
					for (const part of msg.content ?? []) {
						if (part.type === "text" && part.text?.trim()) onEvent({ type: "text", text: part.text });
					}
				}
				onEvent({ type: "usage", usage: { ...usage }, contextPercent: recomputeContext() });
				resetIdle();
				break;
			}
		}
	});

	const onAbort = () => stop("aborted");
	if (args.signal) {
		if (args.signal.aborted) onAbort();
		else args.signal.addEventListener("abort", onAbort, { once: true });
	}

	const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	// Idle timer: resets on every tool call / assistant turn so active subagents stay alive.
	let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => stop("timeout"), timeoutMs);
	const resetIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => stop("timeout"), timeoutMs);
		if (typeof idleTimer === "object" && "unref" in idleTimer) (idleTimer as any).unref();
	};
	resetIdle();

	const firstMessage = `Task: ${args.task}`;
	const reasonText = (r: "aborted" | "timeout" | "turnlimit"): string =>
		r === "timeout" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : r === "turnlimit" ? `hit turn limit (${maxTurns})` : "aborted";

	const promise: Promise<RunResult> = (async () => {
		try {
			onEvent({ type: "status", status: "running" });
			await session.prompt(firstMessage);
			let finalText = session.getLastAssistantText() ?? "";
			// Structured returns: one repair turn if the output misses the schema.
			if (args.validate && !stopReason && finalText.trim()) {
				const repair = args.validate(finalText);
				if (repair) {
					await session.prompt(repair);
					finalText = session.getLastAssistantText() ?? finalText;
				}
			}
			const contextPercent = recomputeContext();
			// A timeout/turn-cap that produced partial text is still a failure, but we keep the text.
			const ok = !stopReason && !!finalText.trim();
			const status: RunStatus = stopReason === "aborted" ? "aborted" : ok ? "done" : "error";
			onEvent({ type: "status", status });
			return {
				ok,
				finalText: finalText || "(no output)",
				usage: { ...usage },
				contextPercent,
				model: `${model.provider}/${model.id}`,
				error: stopReason ? reasonText(stopReason) : undefined,
			};
		} catch (err) {
			onEvent({ type: "status", status: stopReason === "aborted" ? "aborted" : "error" });
			return {
				ok: false,
				finalText: "",
				usage: { ...usage },
				contextPercent: recomputeContext(),
				model: `${model.provider}/${model.id}`,
				error: stopReason ? reasonText(stopReason) : err instanceof Error ? err.message : String(err),
			};
		} finally {
			clearTimeout(idleTimer);
			unsubscribe();
			args.signal?.removeEventListener("abort", onAbort);
			session.dispose();
		}
	})();

	return {
		promise,
		abort: onAbort,
	};
}
