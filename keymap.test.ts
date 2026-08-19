import assert from "node:assert/strict";
import test from "node:test";
import { dataToKeyId, keyIdMatches } from "./keymap.ts";

function label(data: string): string {
	return JSON.stringify(data);
}

test("dataToKeyId maps supported special input chunks to stable ids", () => {
	const cases: Array<[data: string, expected: string]> = [
		["\x1b[A", "up"],
		["\x1b[B", "down"],
		["\x1b[D", "left"],
		["\x1b[C", "right"],
		["\r", "enter"],
		["\x1b", "escape"],
		[" ", "space"],
		["\t", "tab"],
	];

	for (const [data, expected] of cases) {
		assert.equal(dataToKeyId(data), expected, label(data));
	}
});

test("dataToKeyId keeps printable ASCII keys as themselves, except named space", () => {
	for (let code = 33; code <= 126; code++) {
		const char = String.fromCharCode(code);
		assert.equal(dataToKeyId(char), char, label(char));
	}
	assert.equal(dataToKeyId(" "), "space");
});

test("dataToKeyId rejects unsupported chunks", () => {
	const unsupported = [
		"",
		"ab",
		"\x03", // ctrl+c
		"\x7f", // backspace/delete byte
		"\x1b[Z", // shift+tab is intentionally not a bindable id here
		"é",
		"🙂",
	];

	for (const data of unsupported) {
		assert.equal(dataToKeyId(data), null, label(data));
	}
});

test("dataToKeyId rejects pasted special key labels instead of treating them as gestures", () => {
	for (const data of ["up", "down", "left", "right", "enter", "escape", "space", "tab"]) {
		assert.equal(dataToKeyId(data), null, label(data));
	}
});

test("dataToKeyId treats newline as enter", () => {
	assert.equal(dataToKeyId("\n"), "enter");
});

test("dataToKeyId rejects every ctrl-range byte that is not a named special key", () => {
	// ctrl-range bytes: 0x01-0x1f
	// Exceptions: 0x09 (tab→"tab"), 0x0a (newline→"enter"),
	//             0x0d (carriage-return→"enter"), 0x1b (escape→"escape")
	// Also 0x7f (DEL/backspace) is unsupported
	const exceptions = new Set([0x09, 0x0a, 0x0d, 0x1b]);
	for (let code = 0x01; code <= 0x1f; code++) {
		if (exceptions.has(code)) continue;
		assert.equal(dataToKeyId(String.fromCharCode(code)), null, `ctrl-${code}`);
	}
	assert.equal(dataToKeyId("\x7f"), null, "DEL (0x7f)");
});

test("dataToKeyId rejects multi-byte alt/meta prefixes and partial escape sequences", () => {
	const cases = [
		"\x1b[", // partial CSI
		"\x1bO", // partial SS3
		"\x1ba", // alt+a in some terminals
		"\x1b[1~", // home-key sequence (multi-byte, not individually bound)
	];
	for (const data of cases) {
		assert.equal(dataToKeyId(data), null, label(data));
	}
});

test("keyIdMatches treats newline and carriage-return both as enter", () => {
	assert.equal(keyIdMatches("enter", "\n"), true);
	assert.equal(keyIdMatches("enter", "\r"), true);
});

test("keyIdMatches matches empty strings exactly", () => {
	assert.equal(keyIdMatches("", ""), true);
	assert.equal(keyIdMatches("a", ""), false);
	assert.equal(keyIdMatches("", "a"), false);
});

test("keyIdMatches with unrecognized keyIds falls through to exact string match", () => {
	// "return" is not a known special keyId; falls to data===keyId
	assert.equal(keyIdMatches("return", "\r"), false);
	assert.equal(keyIdMatches("backspace", "\x7f"), false);
	assert.equal(keyIdMatches("nonexistent", "\x1b"), false);
});

test("keyIdMatches treats Object prototype names as ordinary unknown ids", () => {
	for (const keyId of ["constructor", "toString", "hasOwnProperty"]) {
		assert.equal(keyIdMatches(keyId, keyId), true, `${keyId} exact match`);
		assert.equal(keyIdMatches(keyId, "\x1b"), false, `${keyId} should not match escape`);
	}
});

test("keyIdMatches special key with wrong data returns false", () => {
	const mismatches: Array<[keyId: string, data: string]> = [
		["up", "\x1b[[["],
		["up", "\x1bOAa"], // extra trailing bytes
		["escape", "\x1b[A"], // escape is single \x1b, not arrow
		["enter", "\n\r"], // multi-byte
		["space", "  "], // two spaces
		["tab", "\t\t"], // two tabs
	];
	for (const [keyId, data] of mismatches) {
		assert.equal(keyIdMatches(keyId, data), false, `${keyId} vs ${label(data)}`);
	}
	// "up" matches "\x1b[A", so "\x1b[B" is different key
	assert.equal(keyIdMatches("up", "\x1b[B"), false);
	// "down" matches "\x1b[B", so "\x1b[A" is different key
	assert.equal(keyIdMatches("down", "\x1b[A"), false);
});

test("keyIdMatches printable and punctuation bindings match their exact raw input", () => {
	for (const keyId of ["a", "Z", ",", "?"]) {
		assert.equal(keyIdMatches(keyId, keyId), true, `${keyId} should match itself`);
	}
});

test("keyIdMatches printable matching is case-sensitive", () => {
	assert.equal(keyIdMatches("a", "A"), false);
	assert.equal(keyIdMatches("z", "Z"), false);
	assert.equal(keyIdMatches("A", "a"), false);
	assert.equal(keyIdMatches("Z", "z"), false);
});

test("keyIdMatches each special key matches its own canonical input", () => {
	// Mirror of the dataToKeyId special mapping — verify the reverse direction.
	const cases: Array<[keyId: string, data: string]> = [
		["up", "\x1b[A"],
		["down", "\x1b[B"],
		["left", "\x1b[D"],
		["right", "\x1b[C"],
		["enter", "\r"],
		["enter", "\n"],
		["escape", "\x1b"],
		["space", " "],
		["tab", "\t"],
	];
	for (const [keyId, data] of cases) {
		assert.equal(keyIdMatches(keyId, data), true, `${keyId} should match ${JSON.stringify(data)}`);
	}
});

test("keyIdMatches each special key does not match another special key's input", () => {
	// Each binding only fires for its own gesture; no false positives between specials.
	const falseMixes: Array<[keyId: string, otherData: string]> = [
		["up", "\x1b[B"], // down arrow
		["down", "\x1b[A"], // up arrow
		["escape", "\n"], // enter
		["enter", "\x1b"], // escape
		["space", "\t"], // tab
		["tab", " "], // space
	];
	for (const [keyId, otherData] of falseMixes) {
		assert.equal(keyIdMatches(keyId, otherData), false, `${keyId} should NOT match ${JSON.stringify(otherData)}`);
	}
});

test("keyIdMatches special key ids require their raw gesture, not the id text", () => {
	const ids = ["up", "down", "left", "right", "enter", "escape", "space", "tab"];
	for (const id of ids) {
		assert.equal(keyIdMatches(id, id), false, `${id} label text should not trigger special binding`);
	}
});

test("dataToKeyId output round-trips through keyIdMatches", () => {
	const inputs = ["\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C", "\r", "\n", "\x1b", " ", "\t", "a", "Z", ","];
	for (const data of inputs) {
		const id = dataToKeyId(data);
		assert.notEqual(id, null, `${label(data)} should be bindable`);
		assert.equal(keyIdMatches(id!, data), true, `${id} should match original ${label(data)}`);
	}
});
