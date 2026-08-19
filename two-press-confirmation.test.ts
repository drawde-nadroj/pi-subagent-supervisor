import assert from "node:assert/strict";
import test from "node:test";
import { TwoPressConfirmation } from "./two-press-confirmation.ts";

function create() {
	return new TwoPressConfirmation({
		isConfirm: (data) => data === "enter",
		isCancel: (data) => data === "esc",
	});
}

test("two-press confirmation arms then commits the same action", () => {
	const c = create();
	assert.deepEqual(c.handle("enter"), { kind: "arm", action: "confirm" });
	assert.equal(c.armed, "confirm");
	assert.equal(c.borderColor(), "success");
	assert.deepEqual(c.handle("enter"), { kind: "commit", action: "confirm" });
	assert.equal(c.armed, null);
});

test("two-press confirmation supports cancel as a separate action", () => {
	const c = create();
	assert.deepEqual(c.handle("esc"), { kind: "arm", action: "cancel" });
	assert.equal(c.armed, "cancel");
	assert.equal(c.borderColor(), "error");
	assert.deepEqual(c.handle("esc"), { kind: "commit", action: "cancel" });
	assert.equal(c.armed, null);
});

test("opposite action switches the armed state instead of committing", () => {
	const c = create();
	assert.deepEqual(c.handle("enter"), { kind: "arm", action: "confirm" });
	assert.deepEqual(c.handle("esc"), { kind: "arm", action: "cancel" });
	assert.equal(c.armed, "cancel");
	assert.deepEqual(c.handle("esc"), { kind: "commit", action: "cancel" });
});

test("ordinary input disarms but remains available to the caller", () => {
	const c = create();
	assert.deepEqual(c.handle("enter"), { kind: "arm", action: "confirm" });
	assert.deepEqual(c.handle("down"), { kind: "disarm", previous: "confirm" });
	assert.equal(c.armed, null);
	assert.equal(c.borderColor(), "accent");
	assert.deepEqual(c.handle("down"), { kind: "pass" });
});

test("reset clears an armed confirmation", () => {
	const c = create();
	c.handle("esc");
	c.reset();
	assert.equal(c.armed, null);
	assert.equal(c.borderColor("muted"), "muted");
});
