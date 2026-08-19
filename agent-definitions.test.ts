import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentFile } from "./agents.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
const load = (name: string) => {
	const file = path.join(dir, `${name}.md`);
	const parsed = parseAgentFile(fs.readFileSync(file, "utf8"), file, "user");
	assert.ok(parsed, `${name} parses`);
	return parsed;
};

for (const name of ["scout", "planner", "worker", "test-writer", "reviewer", "debugger", "oracle"]) {
	const agent = load(name);
	assert.equal(agent.name, name, `${name} command name matches its bundled role ID`);
	assert.equal(agent.auto, true, `${name} remains proactively routable`);
}
const reviewer = load("reviewer");
assert.deepEqual(reviewer.tools, ["read", "grep", "find", "ls", "git-inspect"]);
assert.deepEqual((reviewer.returns as any)?.properties?.verdict?.enum, ["approve", "fix"]);
assert.deepEqual((reviewer.returns as any)?.required, ["verdict", "coverage", "findings"]);
assert.deepEqual((reviewer.returns as any)?.properties?.findings?.items?.required, ["path", "line", "severity", "summary", "fix"]);
assert.match(reviewer.systemPrompt, /P0/);
assert.match(reviewer.systemPrompt, /Return \*\*approve\*\*/);
assert.match(reviewer.systemPrompt, /Return \*\*fix\*\*/);
assert.doesNotMatch(reviewer.systemPrompt, /ship with fixes|blocker \/ should-fix \/ nit/);
const debuggerAgent = load("debugger");
assert.ok(debuggerAgent.spawn.includes("test-writer"));
assert.deepEqual(load("test-writer").spawn, ["debugger"]);

console.log("agent definitions unit tests passed");
