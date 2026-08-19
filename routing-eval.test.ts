import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	FAST_CASE_IDS,
	FIXTURE_FILES,
	ROUTING_EVAL_CASES,
	compareSpawned,
	createFixture,
	isInfraFailure,
	parseSpawnedAgents,
	routingPass,
} from "./routing-eval.ts";

assert.equal(ROUTING_EVAL_CASES.length, 14);
assert.ok(ROUTING_EVAL_CASES.every((c) => c.id && c.prompt && c.expect.length + c.reject.length > 0));

// Every fast-tier id must name a real case.
const allIds = new Set(ROUTING_EVAL_CASES.map((c) => c.id));
assert.ok(FAST_CASE_IDS.every((id) => allIds.has(id)));

// Mutation safety: every case that could write files must run in the fixture, and
// every fixture path a prompt names must actually exist in the fixture.
const mutationCapable = new Set(["worker", "test-writer", "debugger"]);
for (const c of ROUTING_EVAL_CASES) {
	if (c.expect.some((a) => mutationCapable.has(a))) assert.equal(c.cwd, "fixture", `${c.id} can mutate; must run in fixture`);
	for (const m of c.prompt.matchAll(/src\/[\w./-]+\.\w+/g)) {
		assert.ok(m[0] in FIXTURE_FILES, `${c.id} names ${m[0]} which is not in FIXTURE_FILES`);
	}
}

// The fixture builds and contains what the prompts rely on.
const fixture = createFixture();
assert.ok(fs.readFileSync(path.join(fixture, "src/keymap.ts"), "utf-8").includes("DEFAULT_KEYS"));
fs.rmSync(fixture, { recursive: true, force: true });

// Infra failure = crashed before any routing; timeouts and clean exits are not infra.
assert.equal(isInfraFailure({ exitCode: 1, timedOut: false, spawned: [] }), true);
assert.equal(isInfraFailure({ exitCode: null, timedOut: false, spawned: [] }), true);
assert.equal(isInfraFailure({ exitCode: 0, timedOut: false, spawned: [] }), false);
assert.equal(isInfraFailure({ exitCode: 143, timedOut: true, spawned: [] }), false);
assert.equal(isInfraFailure({ exitCode: 1, timedOut: false, spawned: ["scout"] }), false);

assert.deepEqual(parseSpawnedAgents(`thinking...\nsubagent scout\nresult\nsubagent reviewer\n`), []);

assert.deepEqual(
	parseSpawnedAgents(`tool: subagent {"agent":"worker","task":"edit"}\nsubagent-output debugger\n`),
	[],
);
assert.deepEqual(parseSpawnedAgents(`Example JSON: {"agent":"oracle","task":"challenge"}\n`), []);
assert.deepEqual(parseSpawnedAgents("```json\n{\"agent\":\"new-specialist\",\"task\":\"work\"}\n```\n"), []);

assert.deepEqual(parseSpawnedAgents(`SUBAGENT_EVAL_SPAWN scout\nSUBAGENT_EVAL_SPAWN reviewer\n`), ["scout", "reviewer"]);
assert.deepEqual(parseSpawnedAgents(`You should use reviewer subagent for this.`), []);

assert.deepEqual(compareSpawned(["scout"], { expect: ["scout"], reject: ["reviewer"] }, ["scout", "reviewer"]), {
	pass: true,
	missing: [],
	forbidden: [],
	unknown: [],
});

assert.deepEqual(compareSpawned(["scout", "reviewer"], { expect: ["worker"], reject: ["scout"] }, ["scout", "reviewer", "worker"]), {
	pass: false,
	missing: ["worker"],
	forbidden: ["scout", "reviewer"],
	unknown: [],
});
assert.deepEqual(compareSpawned(["oracle", "typo-agent"], { expect: ["oracle"], reject: [] }, ["oracle"]), {
	pass: false,
	missing: [],
	forbidden: [],
	unknown: ["typo-agent"],
});
assert.equal(compareSpawned(["worker", "debugger"], { expect: ["debugger", "worker"], reject: [], expectOrder: ["debugger", "worker"] }, ["debugger", "worker"]).pass, false);
assert.equal(routingPass(true, false, 0), true);
assert.equal(routingPass(true, true, 0), false, "timeouts are inconclusive failures even when spawn assertions match");
assert.equal(routingPass(true, false, 1), false, "a repeated infrastructure failure cannot pass a no-spawn case");
assert.equal(routingPass(true, false, null), false, "a spawn error cannot pass a no-spawn case");

console.log("routing eval unit tests passed");
