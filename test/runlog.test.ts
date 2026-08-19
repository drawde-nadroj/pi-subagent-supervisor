import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aggregateRunStats, appendRunLog, appendRunLogIfEnabled, clearRunLog, entryFromRecord, failureCategory, filterRecentEntries, formatRunStats, getDefaultRunLogPath, readRunLog, type RunLogEntry } from "../src/runlog.ts";
import { RunRegistry } from "../src/registry.ts";
import { createPersona } from "../src/persona.ts";
import { emptyUsage } from "../src/engine.ts";
import type { AgentConfig } from "../src/agents.ts";

const entry = (over: Partial<RunLogEntry>): RunLogEntry => ({
	ts: "2026-07-02T00:00:00.000Z",
	agent: "scout",
	mode: "single",
	status: "done",
	durationMs: 30_000,
	cost: 0.01,
	input: 1000,
	output: 400,
	tools: 5,
	task: "find things",
	...over,
});

const workerAgent = {
	name: "worker",
	displayName: "Worker",
	color: "green",
	spawn: [],
	fallback: [],
} as unknown as AgentConfig;
const scoutAgent = { ...workerAgent, name: "scout", displayName: "Scout", color: "cyan" } as AgentConfig;
let clock = 1_000;
const graph = new RunRegistry({ now: () => clock });
const call = graph.createCall({ mode: "single", cwd: "/tmp/proj" });
const rootId = call.planRoot(workerAgent, `implement\nthe ${"x".repeat(100)}`, createPersona(workerAgent));
const childId = call.spawnChild(rootId, scoutAgent, "inspect", createPersona(scoutAgent));
const loggedRoots: ReturnType<typeof entryFromRecord>[] = [];
graph.onFinish((record) => loggedRoots.push(entryFromRecord(record)));
call.start(rootId);
call.start(childId);
clock = 31_000;
call.finish(childId, { ok: true, finalText: "child", usage: { ...emptyUsage(), cost: 0.02 }, contextPercent: null });
clock = 61_000;
call.finish(rootId, { ok: true, finalText: "root", usage: { ...emptyUsage(), input: 10, output: 20, cost: 0.05, turns: 2, toolCalls: 3 }, contextPercent: 10 });
call.finishCall({ ok: true });
const rec = graph.getRecord(rootId)!;

// entryFromRecord includes the root subtree once, while the compatibility
// finish hook emits no separate nested JSONL entry.
const e = entryFromRecord(rec);
assert.equal(e.agent, "worker");
assert.equal(e.durationMs, 60_000);
assert.ok(Math.abs(e.cost - 0.07) < 1e-9);
assert.ok(!e.task.includes("\n"));
assert.equal(e.task.length, 80);
assert.equal(loggedRoots.length, 1);
assert.ok(Math.abs(loggedRoots[0].cost - 0.07) < 1e-9);

// append/read round-trip, skipping corrupt lines; missing file = [].
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runlog-default-"));
process.env.PI_CODING_AGENT_DIR = dataRoot;
assert.equal(getDefaultRunLogPath(), path.join(dataRoot, "pi-subagents", "runs.jsonl"));
appendRunLog(getDefaultRunLogPath(), entry({}));
assert.equal(fs.statSync(getDefaultRunLogPath()).mode & 0o777, 0o600);
fs.rmSync(dataRoot, { recursive: true, force: true });
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runlog-test-")), "runs.jsonl");
assert.deepEqual(readRunLog(tmp), []);
appendRunLog(tmp, entry({}));
appendRunLog(tmp, entry({ agent: "worker", cost: 0.1, status: "error" }));
fs.appendFileSync(tmp, "not json\n{\"broken\":\n");
appendRunLog(tmp, entry({ agent: "worker", cost: 0.2, durationMs: 90_000, output: 800 }));
const read = readRunLog(tmp);
assert.equal(read.length, 3);

// clear deletes only the history file, distinguishes an absent file, and surfaces other errors.
const stateFile = path.join(path.dirname(tmp), "state.json");
fs.writeFileSync(stateFile, "keep me", "utf8");
assert.equal(clearRunLog(tmp), true);
assert.equal(fs.existsSync(tmp), false);
assert.equal(fs.readFileSync(stateFile, "utf8"), "keep me");
assert.equal(clearRunLog(tmp), false);

// Completion persistence reads the preference for every append, so toggles apply immediately.
let historyEnabled = false;
assert.equal(appendRunLogIfEnabled(tmp, () => historyEnabled, entry({ agent: "off" })), false);
assert.equal(fs.existsSync(tmp), false);
historyEnabled = true;
assert.equal(appendRunLogIfEnabled(tmp, () => historyEnabled, entry({ agent: "on" })), true);
assert.deepEqual(readRunLog(tmp).map((item) => item.agent), ["on"]);
clearRunLog(tmp);

const notAFile = path.join(path.dirname(tmp), "history-directory");
fs.mkdirSync(notAFile);
assert.throws(() => clearRunLog(notAFile), (error: unknown) => (error as NodeJS.ErrnoException).code !== "ENOENT");

// Restore the entries used by the aggregation assertions below.
for (const item of read) appendRunLog(tmp, item);

// aggregate: grouped per agent, sorted by total cost desc, failure count kept.
const stats = aggregateRunStats(read);
assert.deepEqual(stats.map((s) => s.agent), ["worker", "scout"]);
const worker = stats[0];
assert.equal(worker.runs, 2);
assert.equal(worker.failed, 1);
assert.ok(Math.abs(worker.totalCost - 0.3) < 1e-9);
assert.ok(Math.abs(worker.avgCost - 0.15) < 1e-9);
assert.equal(worker.avgDurationMs, 60_000);
assert.equal(worker.avgOutput, 600);

// aggregate: failure breakdown per agent (worker's one error → category "error").
assert.deepEqual(worker.failures, [{ category: "error", count: 1 }]);
assert.deepEqual(stats[1].failures, []); // scout: all succeeded

// format: header + row per agent, a failures section (worker failed once), then footer.
// The window label defaults to "all sessions" and appears in the footer.
const lines = formatRunStats(stats);
assert.match(lines[0], /agent\s+runs\s+fail/);
assert.match(lines[1], /^worker\s/);
assert.ok(lines.includes("failures:"));
assert.ok(lines.some((l) => /worker: 1 error/.test(l)));
const footer = lines[lines.length - 1];
assert.match(footer, /3 runs · \$0\.3100 total · all sessions/);
// explicit window label flows through to the footer.
assert.match(formatRunStats(stats, "last 30 days").at(-1)!, /last 30 days/);
assert.deepEqual(formatRunStats([]), ["No subagent runs logged (all sessions)."]);

// failureCategory: raw strings bucket into stable categories (number-independent).
assert.equal(failureCategory("timed out after 300s"), "timeout");
assert.equal(failureCategory("hit turn limit (60)"), "turn-limit");
assert.equal(failureCategory("aborted"), "aborted");
assert.equal(failureCategory("429 rate limit exceeded"), "quota");
assert.equal(failureCategory("HTTP 503 overloaded"), "provider");
assert.equal(failureCategory("missing the required trailing json block"), "schema");
assert.equal(failureCategory(undefined), "error");

// filterRecentEntries: keeps only entries within the window; days<=0 = all; bad ts kept.
const now = Date.now();
const recent = entry({ ts: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString() });
const old = entry({ ts: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString() });
const undated = entry({ ts: "not-a-date" });
const windowed = filterRecentEntries([recent, old, undated], 30);
assert.ok(windowed.includes(recent));
assert.ok(!windowed.includes(old));
assert.ok(windowed.includes(undated)); // undated kept rather than silently dropped
assert.equal(filterRecentEntries([recent, old], 0).length, 2); // 0 = all time

// Existing JSON lines without newer graph fields remain readable.
fs.appendFileSync(tmp, `${JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", agent: "legacy", mode: "single", status: "done", durationMs: 10, cost: 0.5, input: 1, output: 2, tools: 0, task: "old" })}\n`);
assert.equal(readRunLog(tmp).at(-1)?.agent, "legacy");

fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log("runlog unit tests passed");
