import assert from "node:assert/strict";
import { agentDisplayName, parseAgentFile, READONLY_TOOLS, resolveChildToolNames } from "./agents.ts";
import { serializeAgent } from "./agent-writer.ts";

const parsed = parseAgentFile(
	`---
name: example-worker
description: Example edits
thinking: low
readonly: false
color: yellow
---

Body
`,
	"/tmp/example-worker.md",
	"user",
);

assert.ok(parsed);
assert.equal(parsed.auto, true); // default: advertised
assert.equal(agentDisplayName(parsed), "example-worker"); // absent display names use the durable role

const named = parseAgentFile(
	`---
name: worker
displayName: "  Ada  "
description: Implements changes
color: cyan
---

Body
`,
	"/tmp/worker.md",
	"user",
);
assert.ok(named);
assert.equal(named.displayName, "Ada");

const namedSerialized = serializeAgent({
	name: "worker",
	displayName: "  Ada  ",
	description: "Implements changes",
	thinking: "low",
	readonly: false,
	color: "cyan",
	conventions: false,
	spawn: [],
	systemPrompt: "Prompt",
});
assert.match(namedSerialized, /^name: worker\ndisplayName: Ada$/m);
const namedRoundTrip = parseAgentFile(namedSerialized, "/tmp/worker.md", "user");
assert.equal(namedRoundTrip?.displayName, "Ada");

const blankDisplayName = serializeAgent({
	name: "worker",
	displayName: "   ",
	description: "Implements changes",
	thinking: "low",
	readonly: false,
	color: "cyan",
	conventions: false,
	spawn: [],
	systemPrompt: "Prompt",
});
assert.doesNotMatch(blankDisplayName, /^displayName:/m);

// Renaming the durable role does not silently change the human-facing persona.
const renamedRole = parseAgentFile(
	serializeAgent({
		name: "builder",
		displayName: "Ada",
		description: "Implements changes",
		thinking: "low",
		readonly: false,
		color: "cyan",
		conventions: false,
		spawn: [],
		systemPrompt: "Prompt",
	}),
	"/tmp/builder.md",
	"user",
);
assert.equal(renamedRole?.name, "builder");
assert.equal(renamedRole?.displayName, "Ada");

const manual = parseAgentFile(
	`---
name: planner
description: Written plans
auto: false
color: cyan
---

Body
`,
	"/tmp/planner.md",
	"user",
);

assert.ok(manual);
assert.equal(manual.auto, false);

for (const invalid of ["yes", "1", "advertise", "TRUE-ish"]) {
	const malformed = parseAgentFile(`---\nname: unsafe\ndescription: Invalid auto\nauto: ${invalid}\n---\nBody`, "/tmp/unsafe.md", "user");
	assert.equal(malformed?.auto, false, `invalid explicit auto ${invalid} must fail hidden`);
}
const explicitStringTrue = parseAgentFile(`---\nname: safe\ndescription: String true\nauto: " true "\n---\nBody`, "/tmp/safe.md", "user");
assert.equal(explicitStringTrue?.auto, true);

// Legacy frontmatter migrates: advertise never → manual, always/judgment → auto.
const legacyNever = parseAgentFile(
	`---
name: test-writer
description: Tests
advertise: never
color: cyan
---

Body
`,
	"/tmp/test-writer.md",
	"user",
);
assert.ok(legacyNever);
assert.equal(legacyNever.auto, false);

const legacyJudgment = parseAgentFile(
	`---
name: scout
description: Broad recon
advertise: judgment
color: cyan
---

Body
`,
	"/tmp/scout.md",
	"user",
);
assert.ok(legacyJudgment);
assert.equal(legacyJudgment.auto, true);
for (const invalid of ["sometimes", "1", "true"]) {
	const malformed = parseAgentFile(`---\nname: legacy-unsafe\ndescription: Invalid legacy\nadvertise: ${invalid}\n---\nBody`, "/tmp/legacy-unsafe.md", "user");
	assert.equal(malformed?.auto, false, `invalid legacy advertise ${invalid} must fail hidden`);
}

const serialized = serializeAgent({
	name: "reviewer",
	description: "Review diffs",
	auto: false,
	thinking: "medium",
	readonly: true,
	color: "orange",
	conventions: false,
	spawn: [],
	systemPrompt: "Prompt",
});

assert.match(serialized, /^auto: false$/m);
assert.doesNotMatch(serialized, /^model:/m);
assert.doesNotMatch(serialized, /^advertise:/m);

// auto: true (the default) is omitted from serialized frontmatter.
const defaultAuto = serializeAgent({
	name: "wizard-agent",
	description: "Created by wizard",
	thinking: "low",
	readonly: false,
	color: "cyan",
	conventions: false,
	spawn: [],
	systemPrompt: "Prompt",
});

assert.doesNotMatch(defaultAuto, /^auto:/m);

// Round-trip: serialize → parse keeps auto.
const roundTrip = parseAgentFile(serialized, "/tmp/reviewer.md", "user");
assert.ok(roundTrip);
assert.equal(roundTrip.auto, false);

// Read-only defaults contain only built-ins. The custom git surface appears
// exactly when explicitly requested, so other agents receive no ghost tool name.
assert.deepEqual(READONLY_TOOLS, ["read", "grep", "find", "ls"]);
assert.deepEqual(resolveChildToolNames({ ...roundTrip, tools: undefined }), { tools: ["read", "grep", "find", "ls"] });
assert.deepEqual(resolveChildToolNames({ ...roundTrip, tools: ["read", "git-inspect"] }), { tools: ["read", "git-inspect"] });

// fallback models parse (incl. nicobailon alias) and round-trip.
const fb = parseAgentFile(
	`---
name: worker
description: Impl
model: deepseek-v4-flash
fallback: [deepseek-v4-pro, some/other]
color: green
---

Body
`,
	"/tmp/worker.md",
	"user",
);
assert.ok(fb);
assert.deepEqual(fb.fallback, ["deepseek-v4-pro", "some/other"]);

const fbAlias = parseAgentFile(
	`---
name: worker2
description: Impl
fallbackModels: a, b
color: green
---

Body
`,
	"/tmp/worker2.md",
	"user",
);
assert.ok(fbAlias);
assert.deepEqual(fbAlias.fallback, ["a", "b"]);

const fbSerialized = serializeAgent({
	name: "worker",
	description: "Impl",
	model: "deepseek-v4-flash",
	fallback: ["deepseek-v4-pro"],
	thinking: "low",
	readonly: false,
	color: "green",
	conventions: false,
	spawn: [],
	systemPrompt: "Prompt",
});
assert.match(fbSerialized, /^fallback: \[deepseek-v4-pro\]$/m);
const fbRoundTrip = parseAgentFile(fbSerialized, "/tmp/worker.md", "user");
assert.deepEqual(fbRoundTrip?.fallback, ["deepseek-v4-pro"]);

console.log("agents unit tests passed");
