import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentFile, resolveChildToolNames } from "../src/agents.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
const source = (name: string) => fs.readFileSync(path.join(dir, `${name}.md`), "utf8");
const load = (name: string) => {
	const file = path.join(dir, `${name}.md`);
	const parsed = parseAgentFile(fs.readFileSync(file, "utf8"), file, "user");
	assert.ok(parsed, `${name} parses`);
	return parsed;
};

const names = ["scout", "planner", "worker", "test-writer", "reviewer", "debugger", "oracle"];
const readonlyNames = ["scout", "planner", "reviewer", "oracle"];
const writableNames = ["worker", "test-writer", "debugger"];

assert.deepEqual(
	fs.readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => path.basename(file, ".md")).sort(),
	[...names].sort(),
	"bundled durable names remain unchanged",
);
for (const name of names) {
	const text = source(name);
	const agent = load(name);
	assert.equal(agent.name, name, `${name} command name matches its bundled role ID`);
	assert.doesNotMatch(text, /^displayName:/m, `${name} has no bundled display persona`);
	assert.match(text, /^auto: true$/m, `${name} explicitly opts into automatic routing`);
	assert.equal(agent.displayName, undefined, `${name} parses without a display persona`);
	assert.equal(agent.auto, true, `${name} remains proactively routable`);
	assert.equal(agent.readonly, readonlyNames.includes(name), `${name} has the expected read-only policy`);
}
for (const name of writableNames) {
	assert.deepEqual(load(name).tools, ["read", "bash", "edit", "write"], `${name} has the exact writable tool list`);
}
for (const name of ["scout", "planner", "oracle"]) {
	assert.deepEqual(resolveChildToolNames(load(name)).tools, ["read", "grep", "find", "ls"], `${name} has the exact read-only tool list`);
}
const reviewer = load("reviewer");
assert.deepEqual(resolveChildToolNames(reviewer).tools, ["read", "grep", "find", "ls", "git-inspect"]);
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
