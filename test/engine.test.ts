import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createChildSession, createSpawnTool, emptyUsage, MAX_NESTED_PARALLEL, MAX_SPAWN_DEPTH, resolveAgentModel } from "../src/engine.ts";
import type { AgentConfig } from "../src/agents.ts";

const models = [
	{ provider: "mock", id: "tiny-fast" },
	{ provider: "mock", id: "big-strong" },
	{ provider: "other", id: "parent" },
];
const registry = {
	getAll: () => models,
	find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
} as any;
const parent = models[2] as any;
const agent = (overrides: Partial<AgentConfig>): AgentConfig =>
	({
		name: "agent",
		description: "desc",
		readonly: false,
		auto: true,
		color: "cyan",
		conventions: false,
		spawn: [],
		systemPrompt: "",
		source: "user",
		filePath: "/tmp/agent.md",
		...overrides,
	}) as AgentConfig;

assert.equal(resolveAgentModel(registry, agent({ model: "mock/big-strong" }), parent)?.id, "big-strong");
assert.equal(resolveAgentModel(registry, agent({}), parent)?.id, "parent");
assert.equal(resolveAgentModel(registry, agent({ model: "missing/primary" }), parent), undefined, "an unresolved explicit primary must not silently inherit the parent model");
assert.equal(resolveAgentModel(registry, agent({ model: "missing/fallback" }), parent), undefined, "an unresolved explicit fallback attempt must fail before execution");

// The nested tool must cross the supplied tracked-runner boundary with the
// parent's resolved model, next depth, task, and cancellation signal intact.
const nested = agent({ name: "scout" });
const parentAgent = agent({ name: "worker", spawn: ["scout"] });
const forwarded: Array<{ task: string; parentModel: unknown; depth: number; signal?: AbortSignal; allowSpawn: boolean }> = [];
const parentSignal = new AbortController().signal;
const spawnTool = createSpawnTool({
	agent: parentAgent,
	model: parent,
	signal: parentSignal,
	spawn: {
		depth: 1,
		resolveAgent: (name) => (name === "scout" ? nested : undefined),
		runChild: async (request) => {
			forwarded.push(request);
			return { ok: true, finalText: "tracked child result", usage: { ...emptyUsage(), cost: 0.02 }, contextPercent: 12, model: "mock/tiny-fast" };
		},
	},
});
assert.ok(spawnTool);
const nestedResult = await spawnTool.execute("nested-1", { agent: "scout", task: "inspect this" }, parentSignal, undefined, {} as any);
assert.equal((nestedResult.content[0] as { text: string }).text, "tracked child result");
assert.equal(forwarded.length, 1);
assert.equal(forwarded[0].task, "inspect this");
assert.equal(forwarded[0].parentModel, parent);
assert.equal(forwarded[0].depth, 2);
assert.equal(forwarded[0].signal, parentSignal);
assert.equal(forwarded[0].allowSpawn, true, "single nested delegation may retain its scoped spawn tool");

// Nested parallel execution is bounded, preserves request-order attribution, and
// starts all read-only children without waiting for an earlier child to finish.
const scout = agent({ name: "scout", readonly: true });
const reviewer = agent({ name: "reviewer", readonly: true });
const writer = agent({ name: "worker", readonly: false });
const pending = new Map<string, (text: string) => void>();
const parallelSpawnPermissions: boolean[] = [];
const parallelTool = createSpawnTool({
	agent: agent({ name: "parent", spawn: ["scout", "reviewer", "worker"] }),
	model: parent,
	spawn: {
		depth: 0,
		resolveAgent: (name) => ({ scout, reviewer, worker: writer } as Record<string, AgentConfig>)[name],
		runChild: ({ agent: child, allowSpawn }) => {
			parallelSpawnPermissions.push(allowSpawn);
			return new Promise((resolve) => pending.set(child.name, (text) => resolve({ ok: true, finalText: text, usage: emptyUsage(), contextPercent: null })));
		},
	},
});
assert.ok(parallelTool);
const parallelPromise = parallelTool.execute("parallel", { tasks: [
	{ agent: "scout", task: "inspect" },
	{ agent: "reviewer", task: "review" },
] }, undefined, undefined, {} as any);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.deepEqual([...pending.keys()], ["scout", "reviewer"], "independent children must start concurrently");
assert.deepEqual(parallelSpawnPermissions, [false, false], "parallel leaves must not expose transitive spawning");
pending.get("reviewer")!("review result");
pending.get("scout")!("scout result");
const parallelResult = await parallelPromise;
assert.equal((parallelResult.content[0] as { text: string }).text, "[scout] scout result\n\n[reviewer] review result");

// Nested parallel uses the same one-respawn policy while retaining its existing
// read-only leaf and depth restrictions.
{
	const attempts = new Map<string, number>();
	const permissions: boolean[] = [];
	const retryingTool = createSpawnTool({
		agent: agent({ name: "parent", spawn: ["scout", "reviewer"] }),
		model: parent,
		spawn: {
			depth: MAX_SPAWN_DEPTH - 1,
			resolveAgent: (name) => ({ scout, reviewer } as Record<string, AgentConfig>)[name],
			runChild: async ({ agent: child, depth, allowSpawn, respawnOnFailure }) => {
				assert.equal(depth, MAX_SPAWN_DEPTH);
				let result;
				for (let physical = 0; physical < (respawnOnFailure ? 2 : 1); physical++) {
					permissions.push(allowSpawn);
					const attempt = (attempts.get(child.name) ?? 0) + 1;
					attempts.set(child.name, attempt);
					const ok = child.name === "scout" && attempt === 2;
					result = { ok, finalText: ok ? "recovered" : "partial", error: ok ? undefined : "ordinary task failure", usage: emptyUsage(), contextPercent: null };
					if (ok) break;
				}
				return result!;
			},
		},
	});
	assert.ok(retryingTool);
	const retried = await retryingTool.execute("nested-retry", { tasks: [
		{ agent: "scout", task: "recover" },
		{ agent: "reviewer", task: "fail twice" },
	] }, undefined, undefined, {} as any);
	assert.deepEqual(Object.fromEntries(attempts), { scout: 2, reviewer: 2 });
	assert.deepEqual(permissions, [false, false, false, false]);
	assert.equal((retried.content[0] as { text: string }).text, "[scout] recovered\n\n[reviewer] failed: ordinary task failure");
}

for (const tasks of [
	[{ agent: "worker", task: "write" }],
	[{ agent: "scout", task: "read" }, { agent: "worker", task: "write" }],
]) {
	const rejected = await parallelTool.execute("unsafe", { tasks }, undefined, undefined, {} as any);
	assert.equal(rejected.isError, true);
	assert.match((rejected.content[0] as { text: string }).text, /every target agent is read-only/);
}
const overBound = await parallelTool.execute("large", { tasks: Array.from({ length: MAX_NESTED_PARALLEL + 1 }, () => ({ agent: "scout", task: "read" })) }, undefined, undefined, {} as any);
assert.equal(overBound.isError, true);
assert.match((overBound.content[0] as { text: string }).text, /at most 10/);
for (const malformed of [
	{},
	{ agent: "scout" },
	{ task: "read" },
	{ tasks: [] },
	{ agent: "scout", task: "read", tasks: [{ agent: "reviewer", task: "review" }] },
]) {
	const rejected = await parallelTool.execute("malformed", malformed as any, undefined, undefined, {} as any);
	assert.equal(rejected.isError, true);
	assert.match((rejected.content[0] as { text: string }).text, /exactly one/);
}

// At the depth cap no nested generation is exposed, so another child cannot run.
assert.equal(createSpawnTool({
	agent: parentAgent,
	model: parent,
	spawn: { depth: MAX_SPAWN_DEPTH, resolveAgent: () => nested, runChild: async () => { throw new Error("must not run"); } },
}), undefined);

// Exercise the real SDK construction boundary without prompting the model. This
// catches removed SDK exports/options before a user launches a subagent.
const runtime = await ModelRuntime.create();
const sdkModel = runtime.getModel("openai-codex", "gpt-5.6-terra");
assert.ok(sdkModel);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-sdk-"));
try {
	const session = await createChildSession({
		agent: agent({ model: "openai-codex/gpt-5.6-terra", thinking: "low" }),
		model: sdkModel,
		cwd,
		conventions: false,
		canSpawn: false,
		customTools: [],
	});
	try {
		assert.equal(session.model?.provider, "openai-codex");
		assert.equal(session.model?.id, "gpt-5.6-terra");
	} finally {
		session.dispose();
	}
} finally {
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log("engine unit tests passed");
