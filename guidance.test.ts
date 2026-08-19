import assert from "node:assert/strict";
import { buildActiveAgentsBlock, formatAgentBullet } from "./guidance.ts";
import type { AgentConfig } from "./agents.ts";

const base: AgentConfig = {
	name: "scout",
	description: "Use for broad recon.",
	auto: true,
	readonly: true,
	color: "cyan",
	conventions: false,
	spawn: [],
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/scout.md",
};

assert.equal(
	formatAgentBullet({
		...base,
		name: "  scout\tagent  ",
		description: "Use for\n\tbroad   recon.  ",
	}),
	"- scout agent: Use for broad recon.",
);

assert.equal(buildActiveAgentsBlock([]), "");

const block = buildActiveAgentsBlock([
	{
		...base,
		name: "  scout\tagent  ",
		description: "Use for\n\tbroad   recon.  ",
	},
]);

assert.match(block, /\n# Available subagents\n/);
assert.match(block, /portion that creates or edits/);
assert.match(block, /named-file or named-symbol lookup inline/);
assert.match(block, /Known failures stay with the diagnosis\/fix coordinator/);
assert.match(block, /TDD-first flow needs an expected red/);
assert.match(block, /generic test selection stay with the implementer/);
assert.match(block, /final combined implementation-and-test diff/);
assert.match(block, /complements rather than replaces focused verification/);
assert.match(block, /planning request produces and presents a plan, then STOP/);
assert.match(block, /same original user message explicitly requested both planning and implementation/);
assert.match(block, /implement an existing plan does not need planning again/);
assert.match(block, /2\+ already-justified delegated tasks are independent/);
assert.match(block, /slow branch does not idle ready work/);
assert.match(block, /Do not split work merely to manufacture parallelism/);
assert.match(block, /pair implementation with its review or verification/);
assert.match(block, /explicitly named by the user may still be invoked/);
assert.match(block, /small, nameable edits inline/);
assert.match(block, /known-failure ownership controls the flow/);
assert.match(block, /coordinator owns integration and final verification/);
assert.match(block, /NOT-for boundaries override/);
assert.match(block, /fresh, uncached session/);
assert.deepEqual(
	block.split("\n").filter((line) => line.startsWith("- ")),
	["- scout agent: Use for broad recon."],
);

// Hidden agents are absent byte-for-byte from proactive parent injection.
const mixed = buildActiveAgentsBlock([
	base,
	{ ...base, name: "hidden-secret", description: "DO NOT LEAK THIS DESCRIPTION", auto: false },
]);
assert.match(mixed, /- scout: Use for broad recon\./);
assert.doesNotMatch(mixed, /hidden-secret|DO NOT LEAK/);
assert.equal(buildActiveAgentsBlock([{ ...base, auto: false }]), "");

console.log("guidance unit tests passed");
