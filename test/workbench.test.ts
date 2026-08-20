import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { serializeAgent, writeAgentFile } from "../src/agent-writer.ts";
import { applyCustomToolSelection, createAgentDraft, draftFromAgent, draftToWritable, parseCustomReturns } from "../src/agent-draft.ts";
import { clearDiscoverCache, discoverAgents, parseAgentFile, type AgentConfig } from "../src/agents.ts";
import { Keymap } from "../src/keymap.ts";
import { TwoPressConfirmation } from "../src/two-press-confirmation.ts";
import { acceptProvisionalSuggestion, advanceWorkbench, agentForEdit, editPersistenceDecision, mergeSavedChoices, moveWorkbench, openAgentWorkbench, persistEditDraft, renderWorkbench, retreatWorkbench, reviewPreview, scopedModelNames, workbenchLabels, workbenchModelNames, workbenchOutputName, workbenchThinkingLevels, validateWorkbenchDraft, WORKBENCH_STAGES } from "../src/workbench.ts";

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

test("edit review serializes persisted auto and labels staged auto changes separately", () => {
	for (const [persistedAuto, stagedAuto] of [[true, false], [false, true]] as const) {
		const draft = createAgentDraft();
		draft.name = "worker";
		draft.access = "writable";
		draft.description = "Use for implementation";
		draft.systemPrompt = "Implement changes.";
		draft.auto = stagedAuto;
		const agent = { ...draftToWritable({ ...draft, auto: persistedAuto }), source: "user" } as AgentConfig;
		const preview = reviewPreview(draft, 200, { kind: "edit", agent });
		const serialized = preview.slice(preview.indexOf("Serialized definition:") + 1).map((line) => line.slice(2)).join("\n") + "\n";

		assert.equal(serialized, serializeAgent(draftToWritable({ ...draft, auto: agent.auto })));
		assert.ok(preview.includes(`Pending dashboard confirmation only: Auto routing will become ${stagedAuto ? "proactive" : "manual"}.`));
		assert.equal(preview[0], `Routing: ${persistedAuto ? "proactive" : "manual"}; Use for implementation`);
	}
});

test("edit review omits pending auto notice when dashboard state matches persistence", () => {
	const draft = createAgentDraft();
	draft.name = "worker";
	draft.access = "writable";
	draft.description = "Use for implementation";
	draft.systemPrompt = "Implement changes.";
	const agent = { ...draftToWritable(draft), source: "user" } as AgentConfig;
	assert.doesNotMatch(reviewPreview(draft, 200, { kind: "edit", agent }).join("\n"), /Pending dashboard confirmation/);
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

test("output decoding distinguishes exact presets, None, and Custom", () => {
	const draft = createAgentDraft();
	assert.equal(workbenchOutputName(draft), "None");
	draft.returns = { properties: { findings: { items: { properties: { note: { type: "string" }, line: { type: "number" }, path: { type: "string" } }, required: ["path", "note"], type: "object" }, type: "array" }, open_questions: { items: { type: "string" }, type: "array" } }, required: ["findings"], type: "object" };
	assert.equal(workbenchOutputName(draft), "Findings", "object key order does not turn an exact preset into Custom");
	draft.returns = { type: "string" };
	assert.equal(workbenchOutputName(draft), "Custom");
});

test("unchanged legacy output schemas round-trip, but intentional replacements stay strict", () => {
	const agent = { name: "legacy", returns: { type: "string", description: "legacy unsupported keyword" } } as any as AgentConfig;
	const draft = draftFromAgent({ ...agent, description: "legacy", fallback: [], auto: true, readonly: false, color: "blue", conventions: false, spawn: [], systemPrompt: "legacy", source: "user", filePath: "legacy.md" });
	assert.equal(validateWorkbenchDraft(draft, { kind: "edit", agent: { ...agent, returns: structuredClone(draft.returns) } }).some((issue) => issue.field === "returns"), false);
	draft.returns = { type: "string", description: "new unsupported keyword" } as any;
	assert.equal(validateWorkbenchDraft(draft, { kind: "edit", agent }).some((issue) => issue.field === "returns"), true);
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

test("workbench model choices prefer nonempty scoped models and otherwise use registry order", () => {
	const registry = { getAvailable: () => [{ provider: "r", id: "available" }], getAll: () => [{ provider: "r", id: "all" }] } as any;
	assert.deepEqual(workbenchModelNames({ modelRegistry: registry, scopedModels: [{ model: { provider: "s", id: "one" } }, { model: { provider: "s", id: "one" } }] } as any), ["s/one"]);
	assert.deepEqual(workbenchModelNames({ modelRegistry: registry, scopedModels: [] } as any), ["r/available"]);
});

test("create and edit labels are explicit throughout the shared workbench", () => {
	const draft = createAgentDraft();
	const agent = { name: "worker" } as AgentConfig;
	assert.deepEqual(workbenchLabels({ kind: "create" }), { title: "Create a new subagent", action: "Create", committed: "create" });
	assert.deepEqual(workbenchLabels({ kind: "edit", agent }), { title: "Edit worker", action: "Save", committed: "save" });
	assert.match(renderWorkbench(draft, { stage: 5, selected: 0 }, 100, { kind: "edit", agent }).join("\n"), /Edit worker.*Review[\s\S]*Save: press ⏎ twice/);
});

test("saved unavailable choices are appended, labeled, deduplicated, and preserve selection order", () => {
	assert.deepEqual(mergeSavedChoices(["p/one", "p/one", "p/two", ""], ["p/old", "p/two", "p/older", "p/old"]), [
		{ name: "p/one" },
		{ name: "p/two" },
		{ name: "p/old", note: "(currently unavailable; preserved)" },
		{ name: "p/older", note: "(currently unavailable; preserved)" },
	]);
});

test("thinking choices follow the selected model and preserve unknown saved values", () => {
	const inherited = { reasoning: false } as any;
	const explicit = { reasoning: true } as any;
	const registry = { find: (provider: string, id: string) => provider === "p" && id === "reasoner" ? explicit : undefined } as any;
	assert.deepEqual(workbenchThinkingLevels({ model: inherited, modelRegistry: registry }, ""), ["off"]);
	assert.deepEqual(workbenchThinkingLevels({ model: inherited, modelRegistry: registry }, "p/reasoner"), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(workbenchThinkingLevels({ model: inherited, modelRegistry: registry }, "p/missing"), []);
	assert.deepEqual(mergeSavedChoices([], ["legacy-effort"]), [{ name: "legacy-effort", note: "(currently unavailable; preserved)" }]);
});

function semanticFields(agent: ReturnType<typeof draftToWritable> | AgentConfig) {
	return {
		name: agent.name,
		displayName: agent.displayName,
		description: agent.description,
		model: agent.model,
		fallback: agent.fallback ?? [],
		auto: agent.auto ?? true,
		returns: agent.returns,
		thinking: agent.thinking,
		readonly: agent.readonly,
		tools: agent.tools,
		color: agent.color,
		conventions: agent.conventions,
		spawn: agent.spawn,
		systemPrompt: agent.systemPrompt,
	};
}

test("every bundled definition round-trips through AgentDraft without semantic loss", () => {
	const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
	for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
		const file = path.join(dir, name);
		const agent = parseAgentFile(fs.readFileSync(file, "utf8"), file, "bundled");
		assert.ok(agent, `${name} parses`);
		const writable = draftToWritable(draftFromAgent(agent));
		const reparsed = parseAgentFile(serializeAgent(writable), file, "user");
		assert.ok(reparsed, `${name} serialized draft parses`);
		assert.deepEqual(semanticFields(reparsed), semanticFields(agent), `${name} round-trips through persisted Markdown`);
	}
});

test("representative custom fields, explicit no-tools, and staged auto round-trip exactly", () => {
	const agent: AgentConfig = {
		name: "custom", displayName: "Custom Name", description: "Route this", model: "gone/model", fallback: ["gone/first", "gone/second"], auto: false,
		returns: { type: "object", properties: { result: { type: "string" } } }, thinking: "provider-special", readonly: true, tools: [], color: "pink",
		conventions: true, spawn: ["missing-agent"], systemPrompt: "Do the work.", source: "user", filePath: "/tmp/custom.md",
	};
	const effective = agentForEdit(agent, true);
	assert.equal(effective.auto, true);
	assert.equal(agent.auto, false);
	const draft = draftFromAgent(effective);
	assert.equal(draft.toolMode, "none");
	assert.equal(draft.access, "readonly");
	assert.deepEqual(semanticFields(draftToWritable(draft)), semanticFields(effective));
});

test("edit ownership decisions refuse projects and bundled renames", () => {
	assert.match(editPersistenceDecision({ source: "project", name: "p" }, "p").kind, /refuse/);
	assert.deepEqual(editPersistenceDecision({ source: "bundled", name: "worker" }, "worker"), { kind: "bundled-override" });
	assert.match((editPersistenceDecision({ source: "bundled", name: "worker" }, "renamed") as any).message, /cannot be renamed/);
	assert.deepEqual(editPersistenceDecision({ source: "user", name: "old" }, "new"), { kind: "user-rename" });
});

test("project Edit is refused before opening the workbench", async () => {
	const notices: string[] = [];
	const project = { name: "project", source: "project" } as AgentConfig;
	const ctx = { ui: { notify: (message: string) => notices.push(message), custom: () => { throw new Error("workbench opened"); } } } as any;
	const km = new Keymap({ getKeybinds: () => ({}) } as any);
	assert.equal(await openAgentWorkbench(ctx, km, { kind: "edit", agent: project }), undefined);
	assert.match(notices[0], /read-only/);
});

test("cancel-style draft abandonment performs no writes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-cancel-"));
	try {
		const file = path.join(root, "agent.md");
		fs.writeFileSync(file, "original bytes\n");
		const agent = { name: "a", description: "a", fallback: [], auto: true, readonly: false, color: "blue", conventions: false, spawn: [], systemPrompt: "a", source: "user", filePath: file } as AgentConfig;
		const draft = draftFromAgent(agent);
		draft.description = "abandoned change";
		assert.equal(fs.readFileSync(file, "utf8"), "original bytes\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("edit persistence copies bundled roles and rename collisions preserve both user files", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-persist-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	clearDiscoverCache();
	try {
		const bundled = discoverAgents(root, { includeProject: false }).agents.find((agent) => agent.name === "worker" && agent.source === "bundled")!;
		const bundledDraft = draftFromAgent(bundled);
		bundledDraft.description = "custom bundled override";
		bundledDraft.auto = !bundled.auto;
		const bundledResult = persistEditDraft(bundled, bundledDraft);
		assert.equal(bundledResult.auto, !bundled.auto, "effective auto returns to dashboard staging");
		assert.equal(bundled.source, "bundled");
		const overrideText = fs.readFileSync(path.join(root, "home", "agents", "worker.md"), "utf8");
		assert.match(overrideText, /description: custom bundled override/);
		assert.equal(parseAgentFile(overrideText, bundled.filePath, "user")!.auto, bundled.auto, "Edit does not commit dashboard-staged auto early");

		const userDir = path.join(root, "home", "agents");
		const sourcePath = writeAgentFile({ name: "source", description: "source", color: "blue", systemPrompt: "source" }, userDir);
		const occupiedPath = writeAgentFile({ name: "occupied", description: "occupied", color: "blue", systemPrompt: "occupied" }, userDir);
		const source = parseAgentFile(fs.readFileSync(sourcePath, "utf8"), sourcePath, "user")!;
		const draft = draftFromAgent(source);
		draft.name = "occupied";
		const sourceBytes = fs.readFileSync(sourcePath);
		const occupiedBytes = fs.readFileSync(occupiedPath);
		assert.throws(() => persistEditDraft(source, draft), { code: "EEXIST" });
		assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);
		assert.deepEqual(fs.readFileSync(occupiedPath), occupiedBytes);
	} finally {
		clearDiscoverCache();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
