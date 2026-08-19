import assert from "node:assert/strict";
import { buildReturnsInstruction, checkReturns, extractJsonBlock, formatReturnsJson, validateReturns, type ReturnsSchema } from "../src/returns.ts";

const schema: ReturnsSchema = {
	type: "object",
	required: ["verdict", "findings"],
	properties: {
		verdict: { enum: ["approve", "fix"] },
		findings: {
			type: "array",
			items: { type: "object", required: ["path", "summary"], properties: { path: { type: "string" }, line: { type: "number" }, summary: { type: "string" } } },
		},
	},
};

// extraction: last fenced json block wins; bare trailing JSON also accepted.
assert.deepEqual(extractJsonBlock('prose\n```json\n{"a":1}\n```'), { a: 1 });
assert.deepEqual(extractJsonBlock('```json\n{"a":1}\n```\nmore\n```json\n{"b":2}\n```'), { b: 2 });
assert.deepEqual(extractJsonBlock('findings above\n{"a":[1,2]}'), { a: [1, 2] });
assert.deepEqual(extractJsonBlock('Use {previous} or [literal] in prose\n{"a":[1,2]}'), { a: [1, 2] });
assert.equal(extractJsonBlock("no json here"), undefined);

// presentation: structured JSON is consistently indented and fenced for humans.
assert.equal(
	formatReturnsJson('summary\n```json\n{"verdict":"approve","findings":[{"path":"a.ts","line":3}]}\n```'),
	'summary\n```json\n{\n  "verdict": "approve",\n  "findings": [\n    {\n      "path": "a.ts",\n      "line": 3\n    }\n  ]\n}\n```',
);
assert.equal(
	formatReturnsJson('Use {previous} or [literal] in prose\n{"verdict":"approve"}'),
	'Use {previous} or [literal] in prose\n```json\n{\n  "verdict": "approve"\n}\n```',
);
assert.equal(formatReturnsJson("no json here"), "no json here");

// validation
assert.deepEqual(validateReturns(schema, { verdict: "approve", findings: [] }), []);
assert.deepEqual(validateReturns(schema, { verdict: "fix", findings: [{ path: "a.ts", line: 3, summary: "bug" }] }), []);
assert.ok(validateReturns(schema, { verdict: "maybe", findings: [] }).length > 0); // bad enum
assert.ok(validateReturns(schema, { findings: [] }).some((e) => e.includes("verdict"))); // missing required
assert.ok(validateReturns(schema, { verdict: "fix", findings: [{ path: "a.ts" }] }).some((e) => e.includes("summary"))); // item missing required
assert.ok(validateReturns(schema, "nope").length > 0); // wrong type

// end-to-end check: valid → null, invalid → repair message, missing → repair message
assert.equal(checkReturns(schema, 'looks good\n```json\n{"verdict":"approve","findings":[]}\n```'), null);
assert.match(checkReturns(schema, 'bad\n```json\n{"verdict":"nah","findings":[]}\n```') ?? "", /did not match/);
assert.match(checkReturns(schema, "just prose") ?? "", /missing the required trailing/);

// instruction embeds the schema
assert.match(buildReturnsInstruction(schema), /"verdict"/);

console.log("returns unit tests passed");

assert.ok(validateReturns({ type: "string", enum: ["ok"] }, 1).some((error) => error.includes("expected string")));
assert.ok(validateReturns({ type: "string", enum: ["ok"] }, "bad").some((error) => error.includes("expected one of")));
