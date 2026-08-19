import assert from "node:assert/strict";
import test from "node:test";
import { editorToolsValue } from "../src/dashboard-edit.ts";

test("editor tool values preserve defaults, custom tools, and explicit no-tools", () => {
	assert.equal(editorToolsValue("", false), undefined);
	assert.deepEqual(editorToolsValue("read, grep", true), ["read", "grep"]);
	assert.deepEqual(editorToolsValue("", true), []);
});
