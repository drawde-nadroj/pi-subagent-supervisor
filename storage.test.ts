import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateLegacyStorage } from "./storage.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-storage-"));
try {
	const legacy = path.join(root, "legacy");
	const destination = path.join(root, "data");
	fs.mkdirSync(legacy);
	const state = '{"showCosts":true}\n';
	const runs = '{"agent":"fixture","cost":0}\n';
	fs.writeFileSync(path.join(legacy, "state.json"), state, { mode: 0o644 });
	fs.writeFileSync(path.join(legacy, "runs.jsonl"), runs, { mode: 0o644 });

	migrateLegacyStorage(legacy, destination);

	assert.equal(fs.readFileSync(path.join(destination, "state.json"), "utf8"), state);
	assert.equal(fs.readFileSync(path.join(destination, "runs.jsonl"), "utf8"), runs);
	assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.join(destination, "state.json")).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.join(destination, "runs.jsonl")).mode & 0o777, 0o600);

	const existingState = '{"showCosts":false}\n';
	const existingRuns = '{"agent":"existing","cost":1}\n';
	fs.writeFileSync(path.join(destination, "state.json"), existingState, { mode: 0o600 });
	fs.writeFileSync(path.join(destination, "runs.jsonl"), existingRuns, { mode: 0o600 });
	fs.writeFileSync(path.join(legacy, "state.json"), '{"showCosts":"replacement"}\n');
	fs.writeFileSync(path.join(legacy, "runs.jsonl"), '{"agent":"replacement","cost":2}\n');
	migrateLegacyStorage(legacy, destination);
	assert.equal(fs.readFileSync(path.join(destination, "state.json"), "utf8"), existingState, "existing state is never overwritten");
	assert.equal(fs.readFileSync(path.join(destination, "runs.jsonl"), "utf8"), existingRuns, "existing history is never overwritten");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("storage migration tests passed");
