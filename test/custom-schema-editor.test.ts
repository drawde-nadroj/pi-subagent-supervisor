import assert from "node:assert/strict";
import test from "node:test";
import { customSchemaFromFields, decodeCustomSchema, isCanonicalArrayIndexName, validateCustomFields } from "../src/custom-schema-editor.ts";
import type { ReturnsSchema } from "../src/returns.ts";

test("compatible flat scalar and scalar-list schemas decode in property order", () => {
	const schema: ReturnsSchema = {
		type: "object",
		properties: {
			summary: { type: "string" },
			score: { type: "number" },
			tags: { type: "array", items: { type: "string" } },
			flags: { type: "array", items: { type: "boolean" } },
		},
		required: ["summary", "flags"],
	};
	const decoded = decodeCustomSchema(schema);
	assert.equal(decoded.kind, "compatible");
	if (decoded.kind !== "compatible") return;
	assert.deepEqual(decoded.editor.fields, [
		{ name: "summary", type: "string", required: true },
		{ name: "score", type: "number", required: false },
		{ name: "tags", type: "string-list", required: false },
		{ name: "flags", type: "boolean-list", required: true },
	]);
});

test("array-index name classification matches ECMAScript ordering boundaries", () => {
	for (const name of ["0", "1", "2", "4294967294"]) assert.equal(isCanonicalArrayIndexName(name), true, name);
	for (const name of ["name", "01", "00", "-1", "-0", "1.0", "1e0", "4294967295", "99999999999999999999"]) {
		assert.equal(isCanonicalArrayIndexName(name), false, name);
	}
});

test("canonical generation preserves property and required field order", () => {
	const schema = customSchemaFromFields([
		{ name: "summary", type: "string", required: true },
		{ name: "score", type: "number", required: false },
		{ name: "tags", type: "string-list", required: false },
	]);
	assert.deepEqual(Object.keys(schema.properties!), ["summary", "score", "tags"]);
	assert.deepEqual(schema.required, ["summary"]);
	assert.equal(JSON.stringify(schema), '{"type":"object","properties":{"summary":{"type":"string"},"score":{"type":"number"},"tags":{"type":"array","items":{"type":"string"}}},"required":["summary"]}');

	const authoredPrototype = customSchemaFromFields([{ name: "__proto__", type: "boolean", required: true }]);
	assert.equal(Object.hasOwn(authoredPrototype.properties!, "__proto__"), true);
	assert.deepEqual(authoredPrototype.properties!["__proto__"], { type: "boolean" });
	assert.equal(JSON.stringify(authoredPrototype), '{"type":"object","properties":{"__proto__":{"type":"boolean"}},"required":["__proto__"]}');
});

test("unsupported schemas never decode into lossy guided rows", () => {
	const unsupported: ReturnsSchema[] = [
		{ type: "array", items: { type: "string" } },
		{ type: "object", properties: { nested: { type: "object", properties: {} } } },
		{ type: "object", properties: { choice: { type: "string", enum: ["a", "b"] } } },
		{ type: "object", properties: { rows: { type: "array", items: { type: "object", properties: {} } } } },
		{ type: "object", properties: { values: { type: "array", items: { type: "string", enum: ["a"] } } } },
		{ type: "object", properties: { before: { type: "string" }, "2": { type: "number" }, after: { type: "boolean" } } },
	];
	for (const schema of unsupported) assert.deepEqual(decodeCustomSchema(schema), { kind: "unsupported" });
	assert.deepEqual(decodeCustomSchema({ type: "object", properties: { value: { type: "string" } }, required: ["missing"] }), { kind: "unsupported" });
	assert.deepEqual(decodeCustomSchema({ type: "object", properties: { value: { type: "string" } }, required: ["value", "value"] }), { kind: "unsupported" });
});

test("field validation rejects empty lists, blank names, and duplicate authored names", () => {
	assert.deepEqual(validateCustomFields([]), ["Custom needs at least one field."]);
	assert.match(validateCustomFields([{ name: "  ", type: "string", required: false }])[0]!, /needs a name/);
	assert.match(validateCustomFields([{ name: "4294967294", type: "string", required: false }])[0]!, /array index.*field order/);
	assert.match(validateCustomFields([
		{ name: "same", type: "string", required: false },
		{ name: "same", type: "number", required: true },
	])[0]!, /duplicated/);
	assert.deepEqual(validateCustomFields([
		{ name: "Name", type: "string", required: false },
		{ name: "name", type: "string", required: false },
		{ name: "01", type: "number", required: false },
		{ name: "-1", type: "boolean", required: false },
		{ name: "1.0", type: "string-list", required: false },
		{ name: "4294967295", type: "number-list", required: false },
	]), [], "valid JSON keys remain unchanged");
});
