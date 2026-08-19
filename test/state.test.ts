import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultStatePath, SubagentState } from "../src/state.ts";

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-")), "state.json");
fs.writeFileSync(file, JSON.stringify({ keybinds: { edit: "e" }, structuredReturns: false }), "utf8");
const state = new SubagentState(file);
assert.equal(state.getShowCosts(), false, "old state files default to hidden costs");
assert.equal(state.getHistoryEnabled(), true, "old state files migrate with history enabled");
let changes = 0;
state.onChange(() => changes++);
state.setShowCosts(true);
assert.equal(state.getShowCosts(), true);
assert.equal(changes, 1);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { keybinds: { edit: "e" }, structuredReturns: false, showCosts: true, historyEnabled: true });
assert.equal(new SubagentState(file).getShowCosts(), true);

state.setHistoryEnabled(false);
assert.equal(state.getHistoryEnabled(), false);
assert.equal(new SubagentState(file).getHistoryEnabled(), false, "history off persists across instances");
state.setHistoryEnabled(true);
assert.equal(new SubagentState(file).getHistoryEnabled(), true, "history on persists across instances");
fs.rmSync(path.dirname(file), { recursive: true, force: true });

const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-blocked-"));
const blockedParent = path.join(blockedRoot, "not-a-directory");
fs.writeFileSync(blockedParent, "block");
const blockedState = new SubagentState(path.join(blockedParent, "state.json"));
assert.throws(() => blockedState.setHistoryEnabled(false));
assert.equal(blockedState.getHistoryEnabled(), true, "failed persistence leaves the effective preference unchanged");
fs.rmSync(blockedRoot, { recursive: true, force: true });

const commitFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-commit-"));
const directoryAtStatePath = path.join(commitFailureRoot, "state.json");
fs.mkdirSync(directoryAtStatePath);
const commitFailureState = new SubagentState(directoryAtStatePath);
assert.throws(() => commitFailureState.setHistoryEnabled(false));
assert.equal(commitFailureState.getHistoryEnabled(), true, "failed atomic commit rolls back in-memory preference");
assert.equal(new SubagentState(directoryAtStatePath).getHistoryEnabled(), true, "failed atomic commit cannot change reloaded preference");
assert.deepEqual(fs.readdirSync(commitFailureRoot), ["state.json"], "failed atomic commit removes its private temporary file");
fs.rmSync(commitFailureRoot, { recursive: true, force: true });

const external = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-default-"));
process.env.PI_CODING_AGENT_DIR = external;
assert.equal(getDefaultStatePath(), path.join(external, "pi-subagents", "state.json"));
const defaultState = new SubagentState();
assert.equal(defaultState.getHistoryEnabled(), true, "new state defaults to history enabled");
defaultState.setShowCosts(true);
assert.equal(fs.statSync(getDefaultStatePath()).mode & 0o777, 0o600);
fs.rmSync(external, { recursive: true, force: true });
console.log("state unit tests passed");
