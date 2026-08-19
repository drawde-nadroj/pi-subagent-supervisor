import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyUsage } from "../src/engine.ts";
import { RunRegistry } from "../src/registry.ts";
import { registerSubagentTool } from "../src/tool.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-manual-routing-"));
const agentDir = path.join(cwd, ".pi", "agents");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "scribe.md"), [
	"---",
	"name: scribe",
	"description: Manually invoked test agent.",
	"auto: false",
	"---",
	"Write the requested result.",
].join("\n"));

try {
	let tool: any;
	let executions = 0;
	let currentPrompt: string | undefined;
	registerSubagentTool({ registerTool(value: unknown) { tool = value; } } as any, {
		registry: new RunRegistry(),
		currentUserPrompt: () => currentPrompt,
		getCtx: () => ({ cwd, model: { provider: "mock", id: "parent" }, modelRegistry: { getAll: () => [] } }) as any,
		executeAgent: async () => {
			executions++;
			return {
				promise: Promise.resolve({ ok: true, finalText: "ran", usage: emptyUsage(), contextPercent: null }),
				abort() {},
			};
		},
	});

	const invoke = async (prompt: string | undefined, messages: unknown[]) => {
		currentPrompt = prompt;
		return tool.execute(
			"routing",
			{ agent: "scribe", task: "work" },
			undefined,
			undefined,
			{ cwd, isProjectTrusted: () => true, messages },
		);
	};
	const results = [
		await invoke("Please handle this normally.", [{ role: "user", content: "Please handle this normally." }]),
		await invoke("Please ask scribe to do this.", [{ role: "user", content: "Please ask scribe to do this." }]),
		await invoke("The transcriber should do this.", [{ role: "user", content: "The transcriber should do this." }]),
		await invoke("Now handle this normally.", [
			{ role: "user", content: "Use scribe on the earlier task." },
			{ role: "assistant", content: "Understood." },
			{ role: "user", content: "Now handle this normally." },
		]),
		await invoke("Use /scribe for this task.", [{ role: "user", content: "Use /scribe for this task." }]),
		await invoke(undefined, [{ role: "user", content: "Please ask scribe to do this." }]),
	];

	assert.deepEqual(
		results.map((result) => result.isError !== true),
		[false, true, false, false, true, false],
		"manual agents require a boundary-safe name or /name in proven current-turn input",
	);
	assert.equal(executions, 2, "blocked automatic routes must not reach agent execution");
} finally {
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log("manual tool routing unit tests passed");
