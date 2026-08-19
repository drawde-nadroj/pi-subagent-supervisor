import assert from "node:assert/strict";
import {
	appendDebuggerNudge,
	isTestOrBuildCommand,
} from "./backstops.ts";

assert.equal(isTestOrBuildCommand("npm test"), true);
assert.equal(isTestOrBuildCommand("pnpm run build"), true);
assert.equal(isTestOrBuildCommand("npx tsc --noEmit"), true);
assert.equal(isTestOrBuildCommand("echo test"), false);

assert.deepEqual(
	appendDebuggerNudge([{ type: "text", text: "Command exited with code 1" }], "npm test"),
	[
		{
			type: "text",
			text: "Command exited with code 1\n\nSubagents nudge: `npm test` failed. Treat this as a known failure event and consider routing root-cause work through the debugger subagent.",
		},
	],
);

console.log("backstops unit tests passed");
