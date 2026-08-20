import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { materializeUserOverride, serializeAgent, updateAgentFile, writeAgentFile } from "../src/agent-writer.ts";
import { clearDiscoverCache, discoverAgents, parseAgentFile, type AgentConfig } from "../src/agents.ts";
import { beginOutputFieldNaming, commitOutputFieldNaming, createOutputEditor, cycleOutputEditor, deleteOutputField, effectiveOutputView, moveOutputEditor, outputContractChoice, outputContractChoices, outputFrontmatterPreview, outputSamplePreview, persistOutputEditor, reorderOutputField, replaceCustomWithGuided, reviewOutputEditor, setOutputContract, toggleOutputFieldRequired } from "../src/output-editor.ts";
import { RETURNS_PRESETS } from "../src/result-view.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker", description: "worker", fallback: [], auto: true, readonly: false, color: "cyan",
		conventions: false, spawn: [], systemPrompt: "work", source: "user", filePath: "/tmp/worker.md", ...overrides,
	};
}

test("Output Contract draft lifecycle is in-memory until explicit persistence", () => {
	const original = agent({ returns: RETURNS_PRESETS[0].schema });
	const state = createOutputEditor(original, "readable");
	assert.equal(outputContractChoice(state.draft), "Findings");
	cycleOutputEditor(state, 1);
	assert.equal(outputContractChoice(state.draft), "Review");
	assert.equal(outputContractChoice({ returns: original.returns }), "Findings", "the discovered agent is never mutated");
	reviewOutputEditor(state);
	assert.equal(state.stage, "review");
});

test("None clears both returns and result-view metadata while presets support explicit views", () => {
	const state = createOutputEditor(agent({ returns: RETURNS_PRESETS[2].schema, resultView: "exact" }), "readable");
	setOutputContract(state, "None");
	assert.equal(state.draft.returns, undefined);
	assert.equal(state.draft.resultView, undefined);
	setOutputContract(state, "Review");
	assert.equal(outputContractChoice(state.draft), "Review");
	assert.equal(effectiveOutputView(state), "readable");
	state.row = 1;
	cycleOutputEditor(state, 1);
	assert.equal(state.draft.resultView, "exact");
});

test("Custom is selectable for new agents and existing contracts round-trip", () => {
	const custom = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } as const;
	const state = createOutputEditor(agent({ returns: custom }), "exact");
	assert.deepEqual(outputContractChoices(state), ["None", "Findings", "Review", "Decision", "Custom"]);
	assert.equal(outputContractChoice(state.draft), "Custom");
	setOutputContract(state, "None");
	setOutputContract(state, "Custom");
	assert.deepEqual(state.draft.returns, custom);
	assert.notEqual(state.draft.returns, custom, "the preserved schema is cloned");
	const presetState = createOutputEditor(agent(), "readable");
	assert.deepEqual(outputContractChoices(presetState), ["None", "Findings", "Review", "Decision", "Custom"]);
	setOutputContract(presetState, "Custom");
	assert.deepEqual(presetState.draft.returns, { type: "object", properties: {}, required: [] });
	assert.equal(reviewOutputEditor(presetState), false);
	assert.match(presetState.message!, /at least one field/);
});

test("changing away from an invalid guided Custom clears stale validation", () => {
	for (const replacement of ["Decision", "None"] as const) {
		const state = createOutputEditor(agent(), "readable");
		setOutputContract(state, "Custom");
		assert.equal(reviewOutputEditor(state), false);
		assert.equal(state.message, "Custom needs at least one field.");
		setOutputContract(state, replacement);
		assert.equal(state.message, undefined);
		assert.equal(state.choice, replacement);
	}
});

test("guided Custom transitions update canonical schema and both runtime previews live", () => {
	const state = createOutputEditor(agent(), "readable");
	setOutputContract(state, "Custom");
	for (const name of ["summary", "score", "tags"]) {
		beginOutputFieldNaming(state, "add");
		state.naming!.value = name;
		assert.equal(commitOutputFieldNaming(state), true);
	}
	state.row = 2;
	toggleOutputFieldRequired(state);
	state.row = 3;
	cycleOutputEditor(state, 1);
	state.row = 4;
	cycleOutputEditor(state, 1);
	cycleOutputEditor(state, 1);
	cycleOutputEditor(state, 1);
	assert.deepEqual(state.draft.returns, {
		type: "object",
		properties: {
			summary: { type: "string" },
			score: { type: "number" },
			tags: { type: "array", items: { type: "string" } },
		},
		required: ["summary"],
	});
	const preview = outputSamplePreview(state);
	assert.deepEqual(JSON.parse(preview.exact.join("\n")), { summary: "example summary", score: 1, tags: ["example tags"] });
	assert.deepEqual(outputSamplePreview(state), preview);
	assert.equal(reviewOutputEditor(state), true);
});

test("guided Custom rename, delete, reorder, type, and required edits stay ordered", () => {
	const state = createOutputEditor(agent({ returns: { type: "object", properties: { first: { type: "string" }, second: { type: "boolean" }, third: { type: "number" } }, required: ["second"] } }), "exact");
	assert.equal(state.customMode, "guided");
	assert.deepEqual(state.custom?.fields.map((field) => [field.name, field.type, field.required]), [["first", "string", false], ["second", "boolean", true], ["third", "number", false]]);
	state.row = 3;
	beginOutputFieldNaming(state, "rename");
	state.naming!.value = "renamed";
	commitOutputFieldNaming(state);
	reorderOutputField(state, -1);
	cycleOutputEditor(state, 1);
	toggleOutputFieldRequired(state);
	state.row = 4;
	deleteOutputField(state);
	assert.deepEqual(Object.keys(state.draft.returns!.properties!), ["renamed", "first"]);
	assert.deepEqual(state.draft.returns!.properties!.renamed, { type: "array", items: { type: "string" } });
	assert.deepEqual(state.draft.returns!.required, []);
});

test("invalid empty and duplicate guided names block Review locally", () => {
	const state = createOutputEditor(agent({ returns: { type: "object", properties: { "": { type: "string" }, duplicate: { type: "number" } }, required: [] } }), "readable");
	assert.equal(reviewOutputEditor(state), false);
	assert.match(state.message!, /needs a name/);
	state.custom!.fields[0]!.name = "duplicate";
	state.draft.returns = { type: "object", properties: { duplicate: { type: "string" } }, required: [] };
	assert.equal(reviewOutputEditor(state), false);
	assert.match(state.message!, /duplicated/);
	assert.equal(state.stage, "edit");
});

test("array-index Custom fields are preserve-only", () => {
	const schema = { type: "object", properties: { before: { type: "string" }, "2": { type: "number" }, after: { type: "boolean" } }, required: ["2"] } as const;
	const state = createOutputEditor(agent({ returns: schema }), "readable");
	assert.equal(state.customMode, "preserve-only");
	assert.equal(state.custom, undefined);
	assert.deepEqual(state.draft.returns, schema);
	setOutputContract(state, "None");
	setOutputContract(state, "Custom");
	assert.deepEqual(state.draft.returns, schema);
	assert.equal(reviewOutputEditor(state), true);
});

test("guided naming rejects array indexes immediately but keeps valid numeric-looking names", () => {
	const state = createOutputEditor(agent(), "readable");
	setOutputContract(state, "Custom");
	beginOutputFieldNaming(state, "add");
	state.naming!.value = "1";
	assert.equal(commitOutputFieldNaming(state), false);
	assert.match(state.message!, /array index.*field order/);
	assert.equal(state.naming?.value, "1");
	assert.deepEqual(state.custom?.fields, []);

	state.naming!.value = "01";
	assert.equal(commitOutputFieldNaming(state), true);
	assert.deepEqual(state.custom?.fields.map((field) => field.name), ["01"]);
	state.row = 2;
	beginOutputFieldNaming(state, "rename");
	state.naming!.value = "4294967294";
	assert.equal(commitOutputFieldNaming(state), false);
	assert.match(state.message!, /array index.*field order/);
	assert.equal(state.custom?.fields[0]?.name, "01");
	state.naming!.value = "4294967295";
	assert.equal(commitOutputFieldNaming(state), true);
	assert.deepEqual(Object.keys(state.draft.returns!.properties!), ["4294967295"]);
});

test("guided Review defensively rejects injected array-index names", () => {
	const state = createOutputEditor(agent(), "readable");
	setOutputContract(state, "Custom");
	state.custom!.fields.push({ name: "0", type: "string", required: false });
	assert.equal(reviewOutputEditor(state), false);
	assert.match(state.message!, /array index.*field order/);
	assert.equal(state.stage, "edit");
});

test("unsupported Custom stays exact until explicit guided replacement", () => {
	const unsupported = { type: "object", properties: { nested: { type: "object", properties: { value: { type: "string" } } } }, required: ["nested"] } as const;
	const state = createOutputEditor(agent({ returns: unsupported }), "readable");
	assert.equal(state.customMode, "preserve-only");
	assert.deepEqual(state.draft.returns, unsupported);
	setOutputContract(state, "None");
	setOutputContract(state, "Custom");
	assert.deepEqual(state.draft.returns, unsupported);
	assert.equal(reviewOutputEditor(state), true, "preserve-only schemas can still follow the existing save lifecycle");
	state.stage = "edit";
	replaceCustomWithGuided(state);
	assert.deepEqual(state.draft.returns, { type: "object", properties: {}, required: [] });
	assert.equal(reviewOutputEditor(state), false);
});

test("review preview uses the serializer's exact output frontmatter and explains omitted fields", () => {
	const explicit = createOutputEditor(agent({ returns: RETURNS_PRESETS[1].schema, resultView: "exact" }), "readable");
	assert.deepEqual(outputFrontmatterPreview(explicit), [
		`returns: ${JSON.stringify(RETURNS_PRESETS[1].schema)}`,
		"resultView: exact",
	]);
	const inherited = createOutputEditor(agent({ returns: RETURNS_PRESETS[0].schema }), "exact");
	assert.deepEqual(outputFrontmatterPreview(inherited), [
		`returns: ${JSON.stringify(RETURNS_PRESETS[0].schema)}`,
		"resultView: <omitted; inherits Exact JSON>",
	]);
	const none = createOutputEditor(agent(), "readable");
	assert.deepEqual(outputFrontmatterPreview(none), [
		"returns: <removed from frontmatter>",
		"resultView: <removed from frontmatter>",
	]);
});

test("sample previews are deterministic and expose readable and exact JSON projections", () => {
	for (const preset of RETURNS_PRESETS) {
		const state = createOutputEditor(agent({ returns: preset.schema, resultView: "readable" }), "exact");
		const first = outputSamplePreview(state);
		assert.deepEqual(outputSamplePreview(state), first);
		assert.ok(first.readable.length > 0);
		assert.doesNotThrow(() => JSON.parse(first.exact.join("\n")));
	}
	const none = outputSamplePreview(createOutputEditor(agent(), "readable"));
	assert.match(none.readable.join("\n"), /final text/);
	assert.match(none.exact.join("\n"), /without an output contract/);
});

test("guided Custom persists and reloads with exact ordered rows", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-editor-roundtrip-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	clearDiscoverCache();
	try {
		const userDir = path.join(root, "home", "agents");
		const userPath = writeAgentFile({ name: "roundtrip-role", description: "roundtrip", color: "cyan", systemPrompt: "instructions" }, userDir);
		const selected = parseAgentFile(fs.readFileSync(userPath, "utf8"), userPath, "user")!;
		const state = createOutputEditor(selected, "readable");
		setOutputContract(state, "Custom");
		for (const name of ["summary", "score", "tags"]) {
			beginOutputFieldNaming(state, "add");
			state.naming!.value = name;
			assert.equal(commitOutputFieldNaming(state), true);
		}
		state.row = 2;
		toggleOutputFieldRequired(state);
		state.row = 3;
		cycleOutputEditor(state, 1);
		state.row = 4;
		cycleOutputEditor(state, 1);
		cycleOutputEditor(state, 1);
		cycleOutputEditor(state, 1);
		persistOutputEditor(selected, state.draft);

		clearDiscoverCache();
		const reloaded = parseAgentFile(fs.readFileSync(userPath, "utf8"), userPath, "user")!;
		const expected = {
			type: "object",
			properties: {
				summary: { type: "string" },
				score: { type: "number" },
				tags: { type: "array", items: { type: "string" } },
			},
			required: ["summary"],
		} as const;
		assert.deepEqual(reloaded.returns, expected);
		assert.deepEqual(Object.keys(reloaded.returns!.properties!), ["summary", "score", "tags"]);
		assert.deepEqual(reloaded.returns!.required, ["summary"]);
		const reopened = createOutputEditor(reloaded, "readable");
		assert.equal(reopened.customMode, "guided");
		assert.deepEqual(reopened.custom?.fields, [
			{ name: "summary", type: "string", required: true },
			{ name: "score", type: "number", required: false },
			{ name: "tags", type: "string-list", required: false },
		]);
	} finally {
		clearDiscoverCache();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("untouched unsupported Custom skips persistence and preserves exact bytes and mtime", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-editor-noop-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	clearDiscoverCache();
	try {
		const userDir = path.join(root, "home", "agents");
		fs.mkdirSync(userDir, { recursive: true });
		const userPath = path.join(userDir, "custom-role.md");
		const originalBytes = `---\nname: custom-role\ndescription: custom\ncolor: cyan\nreturns: { "type": "object", "properties": { "answer": { "type": "object", "properties": { "text": { "type": "string" } } } }, "required": ["answer"] }\nresultView: exact\n---\n\nCustom instructions.\n`;
		fs.writeFileSync(userPath, originalBytes);
		const originalMtime = fs.statSync(userPath, { bigint: true }).mtimeNs;
		const selected = parseAgentFile(originalBytes, userPath, "user")!;
		const state = createOutputEditor(selected, "readable");
		assert.equal(outputContractChoice(state.draft), "Custom");
		persistOutputEditor(selected, state.draft);
		assert.equal(fs.readFileSync(userPath, "utf8"), originalBytes);
		assert.equal(fs.statSync(userPath, { bigint: true }).mtimeNs, originalMtime);
	} finally {
		clearDiscoverCache();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent output changes refuse to overwrite the latest definition", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-editor-conflict-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	clearDiscoverCache();
	try {
		const userDir = path.join(root, "home", "agents");
		const userPath = writeAgentFile({ name: "conflict-role", description: "original", color: "blue", systemPrompt: "instructions", returns: RETURNS_PRESETS[0].schema }, userDir);
		const selected = parseAgentFile(fs.readFileSync(userPath, "utf8"), userPath, "user")!;
		const state = createOutputEditor(selected, "readable");
		setOutputContract(state, "Decision");
		updateAgentFile({ ...selected, description: "external description", returns: RETURNS_PRESETS[1].schema, resultView: "exact" });
		const externalBytes = fs.readFileSync(userPath, "utf8");
		assert.throws(() => persistOutputEditor(selected, state.draft), /Output Contract conflict.*changed outside Studio/);
		assert.equal(fs.readFileSync(userPath, "utf8"), externalBytes, "conflict refusal performs no write");
	} finally {
		clearDiscoverCache();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("persistence merges unrelated external fields through the serializer and enforces ownership", () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-editor-persist-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	clearDiscoverCache();
	try {
		const userDir = path.join(root, "home", "agents");
		const userPath = writeAgentFile({ name: "user-role", description: "user", color: "blue", systemPrompt: "instructions" }, userDir);
		const user = parseAgentFile(fs.readFileSync(userPath, "utf8"), userPath, "user")!;
		const userState = createOutputEditor(user, "readable");
		setOutputContract(userState, "Decision");
		userState.draft.resultView = "exact";
		const externallyUpdated = { ...user, description: "changed while Studio was open" };
		updateAgentFile(externallyUpdated);
		persistOutputEditor(user, userState.draft);
		const userText = fs.readFileSync(userPath, "utf8");
		assert.equal(userText, serializeAgent({ ...externallyUpdated, returns: RETURNS_PRESETS[2].schema, resultView: "exact" }), "serializer merges output into the latest file without reverting unrelated changes");

		const bundled = discoverAgents(root, { includeProject: false }).agents.find((item) => item.name === "worker" && item.source === "bundled")!;
		const bundledState = createOutputEditor(bundled, "readable");
		setOutputContract(bundledState, "Review");
		materializeUserOverride({ ...bundled, description: "override created while Studio was open" });
		persistOutputEditor(bundled, bundledState.draft);
		const overridePath = path.join(userDir, "worker.md");
		assert.ok(fs.existsSync(overridePath), "bundled edits materialize or update a user override");
		assert.match(fs.readFileSync(overridePath, "utf8"), /description: override created while Studio was open/, "an intervening override is not reverted");

		const project = agent({ source: "project", filePath: path.join(root, "project", "agent.md") });
		const projectState = createOutputEditor(project, "readable");
		setOutputContract(projectState, "Findings");
		assert.throws(() => persistOutputEditor(project, projectState.draft), /read-only/);
		assert.equal(fs.existsSync(project.filePath), false);
	} finally {
		clearDiscoverCache();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
