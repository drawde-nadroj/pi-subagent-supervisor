import assert from "node:assert/strict";
import { emptyUsage } from "../src/engine.ts";
import { presentMessageIdentity, terminalOutputSummary } from "../src/message-presentation.ts";
import type { CallSnapshot, RunNodeSnapshot } from "../src/registry.ts";

assert.deepEqual(
	presentMessageIdentity({ role: "worker", persona: { base: "Ada", friendDepth: 1 } }),
	{ persona: "Ada’s friend", role: "worker" },
);

assert.deepEqual(
	presentMessageIdentity({ agent: "historical-worker" }),
	{ persona: "historical-worker", role: undefined },
	"legacy stored messages must fall back to their stored role without a roster lookup",
);

assert.deepEqual(
	presentMessageIdentity({ role: "reviewer", persona: { base: "reviewer", friendDepth: 0 } }),
	{ persona: "reviewer", role: undefined },
	"identical persona and role must not render redundant identity",
);

const child = {
	usage: { ...emptyUsage(), input: 20, output: 3, toolCalls: 2, cost: 0.02 },
	children: [],
} as unknown as RunNodeSnapshot;
const root = {
	usage: { ...emptyUsage(), input: 10, output: 5, toolCalls: 1, cost: 0.01 },
	children: [child],
} as unknown as RunNodeSnapshot;
const snapshot = {
	durationMs: 12_345,
	totalCost: 0.03,
	roots: [root],
} as CallSnapshot;
assert.deepEqual(
	terminalOutputSummary({
		ok: true,
		finalText: "parent answer",
		usage: root.usage,
		contextPercent: null,
	}, snapshot),
	{
		ok: true,
		text: "parent answer",
		elapsedMs: 12_345,
		usage: { input: 30, output: 8, cost: 0.03, tools: 3 },
	},
	"terminal summary must retain the answer while deriving metrics from the whole call tree",
);

console.log("message presentation unit tests passed");
