import assert from "node:assert/strict";
import { executeHistoryCommand, parseHistoryCommand, type HistoryPreference } from "../src/history.ts";

assert.equal(parseHistoryCommand("stats"), undefined);
assert.equal(parseHistoryCommand("history"), "invalid");
assert.equal(parseHistoryCommand("history maybe"), "invalid");
assert.equal(parseHistoryCommand("history clear extra"), "invalid");
assert.equal(parseHistoryCommand("history off -k"), "invalid", "malformed history commands cannot become kill commands");
assert.equal(parseHistoryCommand("  HISTORY Off  "), "off");
assert.equal(parseHistoryCommand("history status"), "status");

let enabled = true;
let setCalls = 0;
const state: HistoryPreference = {
	getHistoryEnabled: () => enabled,
	setHistoryEnabled: (next) => {
		enabled = next;
		setCalls++;
	},
};

assert.deepEqual(executeHistoryCommand("status", state, "/history"), {
	message: "Subagent history recording is ON. New completed runs are appended.",
	level: "info",
});
assert.equal(executeHistoryCommand("off", state, "/history").level, "info");
assert.equal(enabled, false);
assert.equal(setCalls, 1);
assert.match(executeHistoryCommand("status", state, "/history").message, /OFF/);
assert.equal(executeHistoryCommand("on", state, "/history").level, "info");
assert.equal(enabled, true);
assert.equal(setCalls, 2);

let clearedPath: string | undefined;
const clearResult = executeHistoryCommand("clear", state, "/history", (file) => {
	clearedPath = file;
	return true;
});
assert.deepEqual(clearResult, {
	message: "Subagent run history cleared. Recording remains ON; new completed runs will be appended.",
	level: "info",
});
assert.equal(clearedPath, "/history");
assert.equal(enabled, true, "clear does not change the recording preference");
enabled = false;
assert.deepEqual(executeHistoryCommand("clear", state, "/history", () => false), {
	message: "No subagent run history file exists. Recording remains OFF.",
	level: "info",
});
assert.equal(enabled, false, "no-file clear also leaves the preference unchanged");
const clearError = executeHistoryCommand("clear", state, "/history", () => {
	throw new Error("permission denied");
});
assert.deepEqual(clearError, {
	message: "Could not clear subagent run history: permission denied",
	level: "error",
});
assert.deepEqual(executeHistoryCommand("invalid", state, "/history"), {
	message: "Usage: /subagents history on|off|status|clear",
	level: "error",
});

const preferenceError = executeHistoryCommand("off", {
	getHistoryEnabled: () => true,
	setHistoryEnabled: () => {
		throw new Error("read-only state");
	},
}, "/history");
assert.deepEqual(preferenceError, {
	message: "Could not turn subagent history recording OFF: read-only state",
	level: "error",
});

console.log("history command tests passed");
