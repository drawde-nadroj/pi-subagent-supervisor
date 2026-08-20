import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { draftFromAgent, draftToWritable } from "../src/agent-draft.ts";
import { serializeAgent } from "../src/agent-writer.ts";
import { parseAgentFile } from "../src/agents.ts";
import { describeStructuredResult, presentResultText, resultSections, RETURNS_PRESETS } from "../src/result-view.ts";

const preset = (name: string) => RETURNS_PRESETS.find((entry) => entry.name === name)!;
const fenced = (value: unknown, prose = "canonical prose") => `${prose}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

test("Findings, Review, and Decision have dedicated readable presentations", () => {
	const cases = [
		["Findings", { findings: [{ path: "src/a.ts", line: 7, note: "Null is retained" }], open_questions: ["Need migration?"] }, [/^## Findings/m, /src\/a\.ts/, /Null is retained/, /## Open questions/, /Need migration/]],
		["Review", { verdict: "fix", coverage: "renderer and storage", findings: [{ path: "src/b.ts", line: 9, severity: "P1", summary: "Wrong view", fix: "store the effective view" }] }, [/^## Verdict: fix/m, /Coverage.*renderer and storage/, /P1/, /store the effective view/]],
		["Decision", { decision: "ship", evidence: ["tests pass"], risks: ["old records"], recommendation: "release" }, [/^## Decision: ship/m, /## Evidence/, /tests pass/, /## Risks/, /## Recommendation\nrelease/]],
	] as const;
	for (const [name, value, patterns] of cases) {
		const text = fenced(value);
		const rendered = presentResultText(text, describeStructuredResult(preset(name).schema, text, "readable"));
		for (const pattern of patterns) assert.match(rendered, pattern, `${name} exposes its named fields`);
		assert.doesNotMatch(rendered, /```json/, `${name} readable view is not raw JSON`);
	}
});

test("generic readable safeguards preserve null and nesting and point truncation to Exact JSON", () => {
	const schema = { type: "object" } as const;
	const value: any = { empty: null, nested: { child: { leaf: "visible" } }, many: Array.from({ length: 45 }, (_, i) => `item-${i}`) };
	value.deep = { a: { b: { c: { d: { e: "too deep" } } } } };
	value.lines = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`line_${i}`, i]));
	const text = fenced(value);
	const rendered = presentResultText(text, describeStructuredResult(schema, text, "readable"));
	assert.match(rendered, /\*\*empty:\*\* null/);
	assert.match(rendered, /leaf.*visible/s);
	for (const safeguard of [/items truncated/, /depth truncated/, /lines truncated/]) assert.match(rendered, safeguard);
	assert.match(rendered, /Exact JSON/i, "every lossy readable projection tells the user where the complete value is available");
});

test("collapsed uses the persisted preferred view; expanded shows preferred then alternate", () => {
	const schema = { type: "object", properties: { answer: { type: "string" } } } as const;
	const canonical = fenced({ answer: "yes" }, "DO NOT REWRITE");
	for (const view of ["readable", "exact"] as const) {
		const descriptor = describeStructuredResult(schema, canonical, view)!;
		const collapsed = resultSections(canonical, descriptor, false);
		const expanded = resultSections(canonical, descriptor, true);
		assert.deepEqual(collapsed.map((x) => x.label), [view === "readable" ? "Readable" : "Exact JSON"]);
		assert.deepEqual(expanded.map((x) => x.label), view === "readable" ? ["Readable", "Exact JSON"] : ["Exact JSON", "Readable"]);
		assert.equal(expanded.find((x) => x.label === "Exact JSON")!.text, JSON.stringify({ answer: "yes" }, null, 2), "Exact JSON is only the extracted value");
	}
	const historical = describeStructuredResult(schema, canonical, "exact")!;
	const laterGlobalSetting = "readable";
	assert.equal(laterGlobalSetting, "readable");
	assert.equal(resultSections(canonical, structuredClone(historical), false)[0]!.label, "Exact JSON", "history uses its stored effective view");
});

test("agent parser, serializer, draft, and bundled definitions retain result view and returns", () => {
	const source = `---\nname: custom\ndescription: custom\nreturns: {"type":"object","properties":{"answer":{"type":"string"}}}\nresultView: exact\n---\n\nAnswer.`;
	const parsed = parseAgentFile(source, "/tmp/custom.md", "user")!;
	assert.equal(parsed.resultView, "exact");
	const viaDraft = draftToWritable(draftFromAgent(parsed));
	const reparsed = parseAgentFile(serializeAgent(viaDraft), "/tmp/custom.md", "user")!;
	assert.deepEqual({ returns: reparsed.returns, resultView: reparsed.resultView }, { returns: parsed.returns, resultView: "exact" });

	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
	for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".md"))) {
		const full = path.join(dir, file), bundled = parseAgentFile(fs.readFileSync(full, "utf8"), full, "bundled")!;
		const roundtrip = parseAgentFile(serializeAgent(draftToWritable(draftFromAgent(bundled))), full, "user")!;
		assert.deepEqual({ returns: roundtrip.returns, resultView: roundtrip.resultView }, { returns: bundled.returns, resultView: bundled.resultView }, `${file} structured presentation round-trips`);
	}
});
