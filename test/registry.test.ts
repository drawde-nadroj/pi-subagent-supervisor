import assert from "node:assert/strict";
import type { AgentConfig } from "../src/agents.ts";
import { emptyUsage } from "../src/engine.ts";
import { createNestedPersona, createPersona } from "../src/persona.ts";
import { capResult, RESULT_CAP_BYTES, RESULT_TRUNCATION_MARKER, RunRegistry } from "../src/registry.ts";
import { entryFromRecord } from "../src/runlog.ts";

const agent = (name: string, color: string): AgentConfig =>
	({
		name,
		displayName: name.toUpperCase(),
		description: "",
		color,
		readonly: false,
		conventions: false,
		spawn: [],
		fallback: [],
		systemPrompt: "",
		source: "user",
		filePath: `/tmp/${name}.md`,
	}) as AgentConfig;

const exactlyAtResultCap = "x".repeat(RESULT_CAP_BYTES);
assert.equal(capResult(exactlyAtResultCap), exactlyAtResultCap);
const cappedResult = capResult(`${exactlyAtResultCap}é`);
assert.ok(Buffer.byteLength(cappedResult, "utf8") <= RESULT_CAP_BYTES);
assert.ok(cappedResult.endsWith(RESULT_TRUNCATION_MARKER));
assert.match(cappedResult, /\[truncated at 50KB/);
const bodyCap = RESULT_CAP_BYTES - Buffer.byteLength(`\n${RESULT_TRUNCATION_MARKER}`, "utf8");
const astralBoundary = capResult(`${"x".repeat(bodyCap - 1)}😀${"x".repeat(RESULT_CAP_BYTES)}`);
assert.equal(astralBoundary, `${"x".repeat(bodyCap - 1)}\n${RESULT_TRUNCATION_MARKER}`);
assert.doesNotMatch(astralBoundary, /�/);
assert.equal(Buffer.byteLength(capResult("x".repeat(1024 * 1024)), "utf8"), RESULT_CAP_BYTES);
const failedCallRegistry = new RunRegistry();
const failedCall = failedCallRegistry.createCall({ mode: "single" });
failedCall.finishCall({ ok: false, error: "x".repeat(RESULT_CAP_BYTES + 1) });
assert.ok(Buffer.byteLength(failedCall.snapshot().error!, "utf8") <= RESULT_CAP_BYTES);
assert.ok(failedCall.snapshot().error!.endsWith(RESULT_TRUNCATION_MARKER));

const scout = agent("scout", "cyan");
const worker = agent("worker", "green");
let now = 1_000;
const registry = new RunRegistry({ now: () => now });

// A missing call boundary would leak one invocation's counts into another.
const first = registry.createCall({ mode: "parallel", cwd: "/tmp/project" });
const second = registry.createCall({ mode: "single", cwd: "/tmp/project", launchSurface: "background" });
const firstA = first.planRoot(scout, "one", createPersona(scout));
const firstB = first.planRoot(worker, "two", createPersona(worker));
const secondA = second.planRoot(scout, "separate", createPersona(scout));
assert.deepEqual(first.snapshot(now).counts, { total: 2, dormant: 2, active: 0, finished: 0, failed: 0 });
assert.deepEqual(second.snapshot(now).counts, { total: 1, dormant: 1, active: 0, finished: 0, failed: 0 });
assert.equal(first.snapshot(now).launchSurface, "foreground");
assert.equal(second.snapshot(now).launchSurface, "background");

// Planning is dormant, and duplicate starts must not rewrite the first timestamp.
assert.equal(first.snapshot(now).roots[0].startedAt, undefined);
now = 1_100;
first.start(firstA);
now = 1_250;
first.start(firstA);
assert.equal(first.snapshot(now).roots[0].startedAt, 1_100);

// Whole-tree counts include descendants and classify both errors and aborts as failed.
const child = first.spawnChild(firstA, scout, "nested", createNestedPersona({ role: "scout", persona: createPersona(scout) }, scout));
first.start(child);
now = 1_300;
first.finish(child, { ok: false, finalText: "", usage: { ...emptyUsage(), cost: 0.02 }, contextPercent: null, error: "boom" });
first.start(firstB);
first.finish(firstB, { ok: false, finalText: "", usage: { ...emptyUsage(), cost: 0.03 }, contextPercent: null, error: "aborted" });
assert.deepEqual(first.snapshot(now).counts, { total: 3, dormant: 0, active: 1, finished: 2, failed: 2 });

// Root and child order remains insertion order after out-of-order completion.
const child2 = first.spawnChild(firstA, worker, "nested second", createPersona(worker));
const child3 = first.spawnChild(firstA, scout, "nested third", createPersona(scout));
first.start(child3);
first.finish(child3, { ok: true, finalText: "third", usage: emptyUsage(), contextPercent: null });
first.start(child2);
first.finish(child2, { ok: true, finalText: "second", usage: emptyUsage(), contextPercent: null });
const ordered = first.snapshot(now);
assert.deepEqual(ordered.roots.map((root) => root.id), [firstA, firstB]);
assert.deepEqual(ordered.roots[0].children.map((node) => node.id), [child, child2, child3]);

// Call wall time starts at call creation, while node duration starts only at start().
now = 1_700;
first.finish(firstA, { ok: true, finalText: "done", usage: { ...emptyUsage(), cost: 0.05 }, contextPercent: 20 });
first.finishCall({ ok: true });
const timed = first.snapshot(2_000);
assert.equal(timed.durationMs, 700);
assert.equal(timed.roots[0].durationMs, 600);

// Own, subtree, call, and session costs derive from node usage exactly once.
assert.equal(timed.roots[0].ownCost, 0.05);
assert.equal(timed.roots[0].subtreeCost, 0.07);
assert.equal(timed.totalCost, 0.1);
second.start(secondA);
second.finish(secondA, { ok: true, finalText: "ok", usage: { ...emptyUsage(), cost: 0.04 }, contextPercent: null });
second.finishCall({ ok: true });
assert.ok(Math.abs(registry.totalCost() - 0.14) < 1e-9);

// A call-finish listener fires once, after orchestration and every node are terminal.
const finishEvents: number[] = [];
registry.onCallFinish((snapshot) => finishEvents.push(snapshot.id));
const third = registry.createCall({ mode: "single" });
const thirdRoot = third.planRoot(worker, "late", createPersona(worker));
third.finishCall({ ok: true });
assert.deepEqual(finishEvents, []);
third.start(thirdRoot);
third.finish(thirdRoot, { ok: true, finalText: "done", usage: emptyUsage(), contextPercent: null });
third.finishCall({ ok: true });
assert.deepEqual(finishEvents, [third.snapshot(now).id]);
third.finishCall({ ok: true });
assert.deepEqual(finishEvents, [third.snapshot(now).id]);

// Stopping a root aborts every active descendant and calls every attached abort handle.
const stopCall = registry.createCall({ mode: "single" });
const stopRoot = stopCall.planRoot(worker, "root", createPersona(worker));
const stopChild = stopCall.spawnChild(stopRoot, scout, "child", createPersona(scout));
const stopGrandchild = stopCall.spawnChild(stopChild, scout, "grandchild", createPersona(scout));
const aborted: number[] = [];
for (const id of [stopRoot, stopChild, stopGrandchild]) {
	stopCall.start(id);
	stopCall.attachHandle(id, { promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null }), abort: () => aborted.push(id) });
}
registry.stop(registry.getRecord(stopRoot)!);
assert.deepEqual(aborted, [stopRoot, stopChild, stopGrandchild]);
assert.deepEqual(stopCall.snapshot(now).counts, { total: 3, dormant: 0, active: 3, finished: 0, failed: 0 });
for (const id of [stopGrandchild, stopChild, stopRoot]) {
	stopCall.finish(id, { ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "aborted" });
}
assert.deepEqual(stopCall.snapshot(now).counts, { total: 3, dormant: 0, active: 0, finished: 3, failed: 3 });

// Once terminal, later lifecycle updates cannot change status, usage, or timestamps.
const immutableBefore = stopCall.snapshot(now).roots[0];
stopCall.start(stopRoot);
stopCall.applyEvent(stopRoot, { type: "usage", usage: { ...emptyUsage(), cost: 99 }, contextPercent: 99 });
stopCall.finish(stopRoot, { ok: true, finalText: "resurrected", usage: { ...emptyUsage(), cost: 99 }, contextPercent: 99 });
const immutableAfter = stopCall.snapshot(now).roots[0];
assert.equal(immutableAfter.status, "aborted");
assert.equal(immutableAfter.ownCost, immutableBefore.ownCost);
assert.equal(immutableAfter.finishedAt, immutableBefore.finishedAt);

// Stop requests abort every handle first, but keeps nodes active so final
// lifecycle usage can settle. Root history waits for the allocated subtree.
const settlingRegistry = new RunRegistry({ now: () => now });
const settlingCall = settlingRegistry.createCall({ mode: "single" });
const settlingRoot = settlingCall.planRoot(worker, "settling root", createPersona(worker));
const settlingChild = settlingCall.spawnChild(settlingRoot, scout, "settling child", createPersona(scout));
settlingCall.start(settlingRoot);
settlingCall.start(settlingChild);
const settlingAborts: number[] = [];
for (const id of [settlingRoot, settlingChild]) {
	settlingCall.attachHandle(id, {
		promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null }),
		abort: () => settlingAborts.push(id),
	});
}
const settlingHistory: Array<{ id: number; cost: number }> = [];
settlingRegistry.onFinish((record) => settlingHistory.push({ id: record.id, cost: entryFromRecord(record).cost }));
settlingRegistry.stop(settlingRegistry.getRecord(settlingRoot)!);
assert.deepEqual(settlingAborts, [settlingRoot, settlingChild]);
assert.equal(settlingCall.snapshot(now).counts.active, 2);
assert.deepEqual(settlingHistory, []);
settlingCall.applyEvent(settlingChild, { type: "usage", usage: { ...emptyUsage(), cost: 0.03 }, contextPercent: 10 });
settlingCall.applyEvent(settlingRoot, { type: "usage", usage: { ...emptyUsage(), cost: 0.02 }, contextPercent: 20 });
settlingCall.finish(settlingRoot, { ok: false, finalText: "", usage: { ...emptyUsage(), cost: 0.02 }, contextPercent: 20, error: "aborted" });
assert.deepEqual(settlingHistory, []);
settlingCall.finish(settlingChild, { ok: false, finalText: "", usage: { ...emptyUsage(), cost: 0.03 }, contextPercent: 10, error: "aborted" });
assert.deepEqual(settlingHistory, [{ id: settlingRoot, cost: 0.05 }]);
assert.equal(settlingCall.snapshot(now).totalCost, 0.05);

// A renderer revision belongs to one call and advances only when that call's
// real lifecycle changes. Reading/materializing elapsed time is not activity.
const revisionRegistry = new RunRegistry({ now: () => now });
const revisionCall = revisionRegistry.createCall({ mode: "single" });
const revisionRoot = revisionCall.planRoot(worker, "revision root", createPersona(worker));
const plannedRevision = revisionCall.snapshot(now).revision;
assert.equal(typeof plannedRevision, "number");
now += 9_999;
assert.equal(revisionCall.snapshot(now).revision, plannedRevision);
revisionCall.start(revisionRoot);
assert.equal(revisionCall.snapshot(now).revision, plannedRevision + 1);
const unrelatedCall = revisionRegistry.createCall({ mode: "single" });
unrelatedCall.planRoot(scout, "unrelated", createPersona(scout));
assert.equal(revisionCall.snapshot(now).revision, plannedRevision + 1);
revisionCall.applyEvent(revisionRoot, { type: "tool", name: "read", argsPreview: "read revision.ts" });
assert.equal(revisionCall.snapshot(now).revision, plannedRevision + 2);
revisionCall.finish(revisionRoot, { ok: true, finalText: "done", usage: emptyUsage(), contextPercent: null });
const terminalRevision = revisionCall.snapshot(now).revision;
revisionCall.finishCall({ ok: true });
assert.equal(revisionCall.snapshot(now).revision, terminalRevision + 1);

// Root-oriented running()/hasActive() remain compatible for kill actions, while
// focused live UI can still detect a quiet descendant after its parent settles.
const descendantRegistry = new RunRegistry({ now: () => now });
const descendantCall = descendantRegistry.createCall({ mode: "single" });
const descendantRoot = descendantCall.planRoot(worker, "parent", createPersona(worker));
const quietChild = descendantCall.spawnChild(descendantRoot, scout, "quiet child", createPersona(scout));
descendantCall.start(descendantRoot);
descendantCall.start(quietChild);
descendantCall.finish(descendantRoot, {
	ok: true,
	finalText: "parent done",
	usage: emptyUsage(),
	contextPercent: null,
});
assert.equal(descendantRegistry.running().length, 0);
assert.equal(descendantRegistry.hasActive(), false);
assert.equal(descendantRegistry.hasActiveNode(), true);
descendantCall.finish(quietChild, {
	ok: true,
	finalText: "child done",
	usage: emptyUsage(),
	contextPercent: null,
});
assert.equal(descendantRegistry.hasActiveNode(), false);

// The backend-neutral bridge publishes detached snapshots and exactly one removal.
const bridgeRegistry = new RunRegistry({ now: () => now });
const bridgeEvents: unknown[] = [];
const bridgeHandlers = new Set<(value: unknown) => void>();
const stopBridge = bridgeRegistry.publishActivityTo({
	emit: (_channel, value) => { bridgeEvents.push(value); for (const handler of bridgeHandlers) handler(value); },
	on: (_channel, handler) => { bridgeHandlers.add(handler); return () => bridgeHandlers.delete(handler); },
});
const bridgeCall = bridgeRegistry.createCall({ mode: "single" });
const bridgeRun = bridgeCall.planRoot(scout, "detached", createPersona(scout));
const published = bridgeEvents.at(-1) as { type: string; snapshot: { roots: Array<{ task: string }> } };
assert.equal(published.type, "snapshot");
bridgeCall.setTask(bridgeRun, "mutated later");
assert.equal(published.snapshot.roots[0].task, "detached");
bridgeCall.finish(bridgeRun, { ok: true, finalText: "done", usage: emptyUsage(), contextPercent: null });
bridgeCall.finishCall({ ok: true });
bridgeCall.finishCall({ ok: true });
assert.equal(bridgeEvents.filter((event) => (event as { type?: string }).type === "removed").length, 1);
stopBridge();

console.log("registry unit tests passed");
