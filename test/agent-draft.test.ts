import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentDraft, draftFromAgent, draftToWritable, parseCustomReturns, RETURNS_PRESETS, validateAgentDraft, validateReturnsSchema } from "../src/agent-draft.ts";
import { parseAgentFile } from "../src/agents.ts";

test("draft defaults and conversion cover writable fields without shared arrays", () => {
	const a = createAgentDraft(), b = createAgentDraft(); a.fallback.push("backup");
	assert.deepEqual(b.fallback, []); a.name = "worker"; a.access = "writable"; a.description = "Use for work"; a.systemPrompt = "Do work";
	assert.deepEqual(draftToWritable(a), { name: "worker", displayName: undefined, description: "Use for work", model: undefined, fallback: ["backup"], auto: true, returns: undefined, thinking: undefined, tools: undefined, readonly: false, color: "cyan", conventions: false, spawn: [], systemPrompt: "Do work" });
});

test("draft validation requires identity, routing, and instructions", () => {
	assert.deepEqual(validateAgentDraft(createAgentDraft()).map((x) => x.field), ["name", "description", "access", "systemPrompt"]);
});

test("returns schema validation is recursive and strict", () => {
	assert.deepEqual(validateReturnsSchema(RETURNS_PRESETS[1].schema), []);
	assert.match(validateReturnsSchema({ type: "object", properties: { x: { type: "wat" } }, required: ["missing"], extra: true }).join("\n"), /unsupported keyword extra/);
	assert.match(validateReturnsSchema({ type: "object", properties: { x: { type: "wat" } }, required: ["missing"] }).join("\n"), /properties.x.type/);
	assert.match(validateReturnsSchema({ type: "array" }).join("\n"), /items/);
	assert.match(validateReturnsSchema({ type: "object", properties: null, required: ["x"] }).join("\n"), /properties/);
});

test("Findings and Review presets exactly match their bundled agent contracts", () => {
	assert.deepEqual(RETURNS_PRESETS.map((x) => x.name), ["Findings", "Review", "Decision"]);
	for (const preset of RETURNS_PRESETS) assert.deepEqual(validateReturnsSchema(preset.schema), []);
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
	for (const [presetName, agentName] of [["Findings", "scout"], ["Review", "reviewer"]] as const) {
		const file = path.join(dir, `${agentName}.md`);
		const parsed = parseAgentFile(fs.readFileSync(file, "utf8"), file, "bundled");
		assert.ok(parsed);
		assert.deepEqual(RETURNS_PRESETS.find((preset) => preset.name === presetName)?.schema, parsed.returns);
	}
});

test("empty Custom output is refused instead of silently clearing output", () => {
	assert.match(parseCustomReturns("  \n\t").error!, /cannot be empty/i);
	assert.equal(parseCustomReturns("  \n\t").schema, undefined);
});

test("access and tool modes are explicit, derived faithfully, and invalid modes cannot convert", () => {
	const fresh = createAgentDraft();
	assert.equal(fresh.access, "unset");
	assert.equal(fresh.toolMode, "defaults");
	assert.throws(() => draftToWritable(fresh), /access/i);
	fresh.access = "writable";
	fresh.toolMode = "custom";
	assert.equal(validateAgentDraft(fresh).filter((issue) => issue.field === "access").length, 1);
	assert.throws(() => draftToWritable(fresh), /at least one tool/i);
	fresh.toolMode = "defaults";
	(fresh as any).access = "invalid";
	assert.equal(validateAgentDraft(fresh).filter((issue) => issue.field === "access").length, 1);
	assert.throws(() => draftToWritable(fresh), /invalid tool access/i);

	for (const [config, expectedAccess, expectedToolMode] of [
		[{ readonly: true }, "readonly", "defaults"],
		[{ readonly: true, tools: [] }, "readonly", "none"],
		[{ readonly: true, tools: ["read", "git-inspect"] }, "readonly", "custom"],
		[{ readonly: false, tools: [] }, "writable", "none"],
		[{ readonly: false, tools: ["read"] }, "writable", "custom"],
		[{ readonly: false }, "writable", "defaults"],
	] as const) {
		const draft = draftFromAgent({ name: "x", description: "x", fallback: [], auto: true, color: "cyan", conventions: false, spawn: [], systemPrompt: "x", source: "user", filePath: "", ...config } as any);
		assert.equal(draft.access, expectedAccess);
		assert.equal(draft.toolMode, expectedToolMode);
		assert.deepEqual(draftToWritable(draft).tools, config.tools);
	}
});

test("schema enums honor declared types and reject unsupported enum types", () => {
	assert.deepEqual(validateReturnsSchema({ enum: ["approve", "fix"] }), []);
	assert.match(validateReturnsSchema({ type: "string", enum: ["ok", 1] }).join("\n"), /match declared type string/);
	assert.match(validateReturnsSchema({ type: "number", enum: [1, "bad"] }).join("\n"), /match declared type number/);
	assert.match(validateReturnsSchema({ type: "wat", enum: ["x"] }).join("\n"), /unsupported type wat/);
	for (const type of ["object", "array", "boolean"] as const) assert.match(validateReturnsSchema({ type, enum: ["x"], ...(type === "array" ? { items: { type: "string" } } : {}) }).join("\n"), /enums are not supported/);
});

test("Decision preset has the exact decision contract", () => {
	assert.deepEqual(RETURNS_PRESETS[2].schema, { type: "object", required: ["decision", "evidence", "risks", "recommendation"], properties: { decision: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, recommendation: { type: "string" } } });
});
