import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { serializeAgent } from "../src/agent-writer.ts";
import { applyCustomToolSelection, createAgentDraft, draftFromAgent, draftToWritable, parseCustomReturns } from "../src/agent-draft.ts";
import { TwoPressConfirmation } from "../src/two-press-confirmation.ts";
import { acceptProvisionalSuggestion, advanceWorkbench, moveWorkbench, renderWorkbench, retreatWorkbench, reviewPreview, scopedModelNames, wizardModelNames, WORKBENCH_STAGES } from "../src/wizard.ts";

test("workbench stages, navigation, and cancellation semantics are stable", () => {
	assert.deepEqual(WORKBENCH_STAGES, ["Identity", "Routing", "Capabilities", "Instructions", "Output", "Review"]);
	assert.deepEqual(moveWorkbench({ stage: 0, selected: 0 }, -1), { stage: 0, selected: 2 });
	assert.deepEqual(advanceWorkbench({ stage: 0, selected: 2 }), { stage: 1, selected: 0 });
	assert.deepEqual(retreatWorkbench({ stage: 1, selected: 1 }), { stage: 0, selected: 0 });
	assert.deepEqual(retreatWorkbench({ stage: 0, selected: 1 }), { stage: 0, selected: 1 });
});

test("every stage render and serialized review preview is width-safe", () => {
	const draft = createAgentDraft();
	draft.name = "long-agent";
	draft.access = "writable";
	draft.description = "A deliberately long routing description that must wrap safely";
	draft.systemPrompt = "A long instruction line that also must wrap safely.";
	for (let stage = 0; stage < WORKBENCH_STAGES.length; stage++) {
		const lines = renderWorkbench(draft, { stage, selected: 0 }, 24);
		assert.ok(lines.every((line) => visibleWidth(line) <= 24));
	}
	const preview = reviewPreview(draft, 18);
	assert.ok(preview.every((line) => visibleWidth(line) <= 18));
	assert.match(preview.join("\n"), /Serialized\ndefinition:/);
	assert.ok(preview.join("\n").includes("name: long-agent"));
});

test("review renders incomplete access safely and exact valid summaries", () => {
	const draft = createAgentDraft();
	assert.deepEqual(reviewPreview(draft, 200), [
		"Routing: proactive; ",
		"Permissions: unset",
		"Model: inherited; fallback none; thinking inherited",
		"Delegation: conventions off; spawn none",
		"Output: None",
		"Serialized definition unavailable until valid tool access is selected.",
	]);
	draft.name = "worker";
	draft.access = "writable";
	draft.description = "Use for implementation";
	draft.systemPrompt = "Implement changes.";
	assert.deepEqual(reviewPreview(draft, 200), [
		"Routing: proactive; Use for implementation",
		"Permissions: writable, default tools",
		"Model: inherited; fallback none; thinking inherited",
		"Delegation: conventions off; spawn none",
		"Output: None",
		"Serialized definition:",
		...serializeAgent(draftToWritable(draft)).trimEnd().split("\n").map((line) => `  ${line}`),
	]);
	draft.access = "writable";
	draft.toolMode = "custom";
	draft.tools = ["read", "ffgrep"];
	const customReview = reviewPreview(draft, 200);
	assert.equal(customReview[1], "Permissions: writable, custom (read, ffgrep)");
	assert.ok(customReview.includes("  tools: [read, ffgrep]"));
	draft.access = "readonly";
	draft.toolMode = "none";
	draft.tools = [];
	const noToolsReview = reviewPreview(draft, 200);
	assert.equal(noToolsReview[1], "Permissions: readonly, no tools");
	assert.ok(noToolsReview.includes("  tools: []"));
});

test("suggestions remain provisional and model choices preserve scoped order without duplicates", () => {
	assert.equal(acceptProvisionalSuggestion("original", undefined), "original");
	assert.equal(acceptProvisionalSuggestion("original", "accepted edit"), "accepted edit");
	assert.deepEqual(scopedModelNames([
		{ provider: "p", id: "second" },
		{ provider: "p", id: "first" },
		{ provider: "p", id: "second" },
		{ provider: "q", id: "first" },
	]), ["p/second", "p/first", "q/first"]);
});

test("workbench save uses the existing serializer through draft conversion", () => {
	const draft = createAgentDraft();
	draft.name = "worker";
	draft.access = "writable";
	draft.description = "Use for implementation";
	draft.systemPrompt = "Implement changes.";
	draft.fallback = ["provider/backup"];
	const serialized = serializeAgent(draftToWritable(draft));
	assert.match(serialized, /fallback: \[provider\/backup\]/);
	assert.match(serialized, /Implement changes\./);
	draft.access = "writable";
	draft.tools = [];
	assert.doesNotMatch(serializeAgent(draftToWritable(draft)), /tools:/);
});

test("custom output rejects malformed and recursively unsupported schemas", () => {
	assert.match(parseCustomReturns("{").error!, /JSON|position|Expected/i);
	assert.match(parseCustomReturns(JSON.stringify({ type: "object", properties: { nested: { type: "string", description: "unsupported" } } })).error!, /unsupported keyword description/);
	assert.deepEqual(parseCustomReturns(JSON.stringify({ type: "array", items: { type: "string" } })).schema, { type: "array", items: { type: "string" } });
});

test("review confirmation requires two presses and cancel remains distinct", () => {
	const confirmation = new TwoPressConfirmation({ isConfirm: (key) => key === "enter", isCancel: (key) => key === "escape" });
	assert.equal(confirmation.handle("enter").kind, "arm");
	assert.deepEqual(confirmation.handle("enter"), { kind: "commit", action: "confirm" });
	assert.equal(confirmation.handle("escape").kind, "arm");
	assert.deepEqual(confirmation.handle("escape"), { kind: "commit", action: "cancel" });
});

test("AgentConfig converts to an independent draft and back to writable form", () => {
	const config: any = { name: "scout", displayName: "Scout", description: "Find things", model: "p/m", fallback: ["p/b"], auto: false, returns: undefined, thinking: "low", tools: ["read"], readonly: true, color: "blue", conventions: true, spawn: ["reviewer"], systemPrompt: "Search", source: "user", filePath: "x" };
	const draft = draftFromAgent(config);
	draft.fallback.push("p/c");
	assert.deepEqual(config.fallback, ["p/b"]);
	const writable = draftToWritable(draft);
	assert.equal(writable.displayName, "Scout");
	assert.equal(writable.readonly, true);
	assert.deepEqual(writable.tools, ["read"]);
});

test("empty or cancelled Custom selection preserves both permission dimensions", () => {
	assert.deepEqual(
		applyCustomToolSelection({ access: "readonly", toolMode: "defaults", tools: [] }, undefined, "writable"),
		{ access: "readonly", toolMode: "defaults", tools: [] },
	);
	assert.deepEqual(
		applyCustomToolSelection({ access: "writable", toolMode: "defaults", tools: [] }, [], "readonly"),
		{ error: "Custom tool access requires at least one tool." },
	);
	assert.deepEqual(
		applyCustomToolSelection({ access: "writable", toolMode: "defaults", tools: [] }, ["read"], "readonly"),
		{ access: "readonly", toolMode: "custom", tools: ["read"] },
	);
});

test("wizard model choices prefer nonempty scoped models and otherwise use registry order", () => {
	const registry = { getAvailable: () => [{ provider: "r", id: "available" }], getAll: () => [{ provider: "r", id: "all" }] } as any;
	assert.deepEqual(wizardModelNames({ modelRegistry: registry, scopedModels: [{ model: { provider: "s", id: "one" } }, { model: { provider: "s", id: "one" } }] } as any), ["s/one"]);
	assert.deepEqual(wizardModelNames({ modelRegistry: registry, scopedModels: [] } as any), ["r/available"]);
});
