import assert from "node:assert/strict";
import test from "node:test";
import { classifyResultPreset, describeStructuredResult, presentResultText, resolveResultView, RETURNS_PRESETS, structuredViewHint } from "../src/result-view.ts";

const objectSchema = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } } as const;
const canonical = 'Human context remains canonical.\n```json\n{"verdict":"approve"}\n```';

test("structured descriptors are versioned recipes without parsed values and fail closed", () => {
	const descriptor = describeStructuredResult(objectSchema, canonical, "readable")!;
	assert.deepEqual(descriptor, { schemaVersion: 1, view: "readable", kind: "custom", schema: objectSchema });
	assert.equal("value" in descriptor, false);
	assert.equal(presentResultText(canonical, { view: "readable" } as any), canonical);
	assert.equal(presentResultText(canonical, { ...descriptor, schemaVersion: 2 } as any), canonical);
	assert.equal(presentResultText(canonical, { ...descriptor, schema: { type: "object", properties: null } } as any, true), canonical, "malformed nested schemas fail closed in expanded rendering");
	for (const type of [["object"], {}, 1, null]) assert.equal(presentResultText(canonical, { ...descriptor, schema: { type } } as any), canonical, "non-string schema types fail closed");
	assert.equal(presentResultText('```json\n{}\n```', descriptor), '```json\n{}\n```');
});

test("readable is the default while an agent override wins and can be reset", () => {
	assert.equal(resolveResultView(undefined, "readable"), "readable");
	assert.equal(resolveResultView("exact", "readable"), "exact");
	assert.equal(resolveResultView(undefined, "readable"), "readable");
});

test("exact renders only the extracted value and expanded renders preferred first", () => {
	const descriptor = describeStructuredResult(objectSchema, canonical, "exact")!;
	assert.equal(presentResultText(canonical, descriptor), JSON.stringify({ verdict: "approve" }, null, 2));
	const expanded = presentResultText(canonical, descriptor, true);
	assert.ok(expanded.indexOf("## Exact") < expanded.indexOf("## Readable"));
	assert.equal(structuredViewHint("F8", false), "F8 shows both structured result views");
	assert.equal(structuredViewHint("F8", true), "F8 collapses structured result views");
});

test("oversized exact projections and custom descriptor recipes fail closed to raw", () => {
	const hugeValue = `x${"*".repeat(51 * 1024)}`;
	const hugeText = `\`\`\`json\n${JSON.stringify({ verdict: hugeValue })}\n\`\`\``;
	assert.equal(describeStructuredResult(objectSchema, hugeText, "exact"), undefined);
	const hugeSchema = { type: "object", properties: Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`field_${index}`, { type: "string" }])) } as const;
	const tinyText = '```json\n{}\n```';
	assert.equal(describeStructuredResult(hugeSchema, tinyText, "readable"), undefined);
	const schemaAt = (bytes: number) => {
		const schema = { type: "object", properties: { x: { enum: [""] } } } as any;
		const descriptor = { schemaVersion: 1, view: "readable", kind: "custom", schema };
		const overhead = Buffer.byteLength(JSON.stringify(descriptor), "utf8");
		schema.properties.x.enum[0] = "x".repeat(bytes - overhead);
		return schema;
	};
	assert.ok(describeStructuredResult(schemaAt(50 * 1024), tinyText, "readable"), "a complete descriptor exactly at the cap is retained");
	assert.equal(describeStructuredResult(schemaAt(50 * 1024 + 1), tinyText, "readable"), undefined, "the full descriptor is capped, not only its schema");
});

test("generic readable output preserves primitives, null, arrays, and nesting deterministically", () => {
	const schema = { type: "object" } as const;
	const text = '```json\n{"truth":true,"count":0,"empty":null,"sequence":["first",2,false],"nested":{"child_name":"kept"}}\n```';
	const descriptor = describeStructuredResult(schema, text, "readable")!;
	assert.equal(presentResultText(text, descriptor), "**truth:** true\n**count:** 0\n**empty:** null\n### sequence\n- first\n- 2\n- false\n### nested\n**child name:** kept");
	assert.equal(presentResultText(text, descriptor), presentResultText(text, structuredClone(descriptor)));
});

test("preset classification uses exact schema equality independent of object key order", () => {
	for (const preset of RETURNS_PRESETS) assert.equal(classifyResultPreset(structuredClone(preset.schema)), preset.name);
	assert.equal(classifyResultPreset({ ...RETURNS_PRESETS[0]!.schema, required: [] }), undefined);
});
