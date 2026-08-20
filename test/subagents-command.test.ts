import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerExtension from "../src/index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-command-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;

try {
	const commands = new Map<string, any>();
	const events = new Map<string, Function[]>();
	const sent: any[] = [];
	const pi = {
		events: { emit() {} },
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer() {},
		registerTool() {},
		sendMessage: (message: any) => sent.push(message),
		on: (name: string, listener: Function) => {
			events.set(name, [...(events.get(name) ?? []), listener]);
			return () => {};
		},
	} as any;
	registerExtension(pi);

	assert.ok(commands.has("subagents"), "/subagents is registered");
	assert.equal(commands.has("agents"), false, "/agents is absent");
	const command = commands.get("subagents");
	assert.match(command.description, /Subagent Studio.*\/subagents -k.*\/subagents stats/);

	const notices: Array<{ message: string; level: string }> = [];
	const uiCtx = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => false,
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
	} as any;

	await command.handler("-k", uiCtx);
	assert.equal(notices.at(-1)?.message, "No running subagents.");
	await command.handler("returns off", uiCtx);
	assert.match(notices.at(-1)?.message ?? "", /Structured returns OFF/);
	await command.handler("returns on", uiCtx);
	assert.match(notices.at(-1)?.message ?? "", /Structured returns ON/);
	await command.handler("history status", uiCtx);
	assert.match(notices.at(-1)?.message ?? "", /Subagent history recording is ON/);

	const beforeStats = sent.length;
	await command.handler("stats", uiCtx);
	assert.equal(sent.length, beforeStats + 1);
	assert.match(sent.at(-1)?.content ?? "", /No subagent runs logged \(last 30 days\)/);

	const printCtx = { ...uiCtx, mode: "print", hasUI: false };
	await command.handler("", printCtx);
	assert.match(sent.at(-1)?.content ?? "", /Available subagents:[\s\S]*Other commands: \/subagents stats/);
} finally {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("subagents command unit tests passed");
