import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultStatePath, SubagentState } from "./state.ts";

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-")), "state.json");
fs.writeFileSync(file, JSON.stringify({ keybinds: { edit: "e" }, structuredReturns: false }), "utf8");
const state = new SubagentState(file);
assert.equal(state.getShowCosts(), false, "old state files default to hidden costs");
let changes = 0;
state.onChange(() => changes++);
state.setShowCosts(true);
assert.equal(state.getShowCosts(), true);
assert.equal(changes, 1);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { keybinds: { edit: "e" }, structuredReturns: false, showCosts: true });
assert.equal(new SubagentState(file).getShowCosts(), true);
fs.rmSync(path.dirname(file), { recursive: true, force: true });

const external = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-default-"));
process.env.PI_CODING_AGENT_DIR = external;
assert.equal(getDefaultStatePath(), path.join(external, "pi-subagents", "state.json"));
const defaultState = new SubagentState();
defaultState.setShowCosts(true);
assert.equal(fs.statSync(getDefaultStatePath()).mode & 0o777, 0o600);
fs.rmSync(external, { recursive: true, force: true });
console.log("state unit tests passed");
