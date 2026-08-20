import assert from "node:assert/strict";
import test from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { Keymap } from "../src/keymap.ts";
import { pickColor, pickMulti, pickTools } from "../src/pickers.ts";
import { showPreferences } from "../src/settings.ts";
import { createAgentDraft } from "../src/agent-draft.ts";
import { openAgentWorkbench, renderWorkbench } from "../src/workbench.ts";

const theme = { fg: (_color: string, text: string) => text };
const tui = { requestRender() {} };

function keymap(bindings: Record<string, unknown> = {}) {
	const state = { getKeybinds: () => ({}) } as any;
	const manager = new KeybindingsManager(TUI_KEYBINDINGS, bindings as any);
	return { km: new Keymap(state), manager };
}

function scriptedContext(manager: KeybindingsManager, scripts: string[][], widths: number[] = []) {
	const renders: Array<{ width: number; lines: string[] }> = [];
	const notices: string[] = [];
	const ctx: any = {
		cwd: process.cwd(), modelRegistry: { getAvailable: () => [], getAll: () => [] },
		ui: {
			notify: (message: string) => notices.push(message),
			custom: (factory: any) => new Promise((resolve) => {
				const component = factory(tui, theme, manager, resolve);
				for (const width of widths) {
					component.invalidate?.();
					renders.push({ width, lines: component.render(width) });
				}
				for (const input of scripts.shift() ?? []) component.handleInput(input);
			}),
		},
	};
	return { ctx, renders, notices };
}

function assertWidthBounded(renders: Array<{ width: number; lines: string[] }>) {
	for (const { width, lines } of renders) {
		assert.ok(lines.length > 0, `rendered content at width ${width}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `all lines fit width ${width}`);
	}
}

test("Preferences honors injected navigation, shows effective hints, and only points to keybindings.json", async () => {
	const { km, manager } = keymap({
		"tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "y", "tui.select.cancel": "x",
	});
	const writes: string[] = [];
	const state: any = {
		getKeybinds: () => ({}), setKeybind: () => writes.push("setKeybind"), resetKeybinds: () => writes.push("resetKeybinds"),
		getShowCosts: () => false, setShowCosts: () => writes.push("setShowCosts"),
		getResultView: () => "readable", setResultView: () => writes.push("setResultView"),
		getPromptCaptureEnabled: () => false, setPromptCaptureEnabled: () => writes.push("setPromptCaptureEnabled"),
	};
	const harness = scriptedContext(manager, [["j", "j", "j", "y", "x"]], [20, 24, 80]);
	await showPreferences(harness.ctx, km, state);
	assert.deepEqual(writes, [], "opening the keybinding row performs no state write");
	assert.match(harness.notices.join("\n"), /~\/\.pi\/agent\/keybindings\.json.*\/reload/);
	assert.match(harness.renders.at(-1)!.lines.join("\n"), /k\/j move.*y change.*x close/);
	assertWidthBounded(harness.renders);
});

test("picker honors injected navigation and configurable package toggle while hints stay width-safe", async () => {
	const { km, manager } = keymap({
		"tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "y", "pi-subagent-supervisor.toggle": "t",
	});
	const harness = scriptedContext(manager, [["j", "t", "y"]], [20, 24, 80]);
	assert.deepEqual(await pickTools(harness.ctx, km, []), ["grep"]);
	assert.match(harness.renders.at(-1)!.lines.join("\n"), /k\/j move.*t toggle.*y save/);
	assertWidthBounded(harness.renders);
});

test("disabled picker package toggle does not change selection", async () => {
	const { km, manager } = keymap({ "tui.select.confirm": "y", "pi-subagent-supervisor.toggle": [] });
	const harness = scriptedContext(manager, [[" ", "y"]]);
	assert.deepEqual(await pickTools(harness.ctx, km, []), []);
});

test("pickMulti uses injected bindings, preserves selected order, and fits representative widths", async () => {
	const { km, manager } = keymap({ "tui.select.down": "j", "tui.select.confirm": "y", "tui.select.cancel": "x", "pi-subagent-supervisor.toggle": "t" });
	const harness = scriptedContext(manager, [["j", "t", "j", "t", "y"]], [20, 24, 80]);
	assert.deepEqual(await pickMulti(harness.ctx, km, "Models", [{ name: "one" }, { name: "two" }, { name: "three" }], []), ["two", "three"]);
	assert.match(harness.renders.at(-1)!.lines.join("\n"), /j move.*t toggle.*y save.*x cancel/);
	assertWidthBounded(harness.renders);
});

test("pickColor uses injected direction and confirmation bindings at representative widths", async () => {
	const { km, manager } = keymap({ "tui.editor.cursorRight": "l", "tui.select.confirm": "y", "tui.select.cancel": "x" });
	const harness = scriptedContext(manager, [["l", "y"]], [20, 24, 80]);
	assert.equal(await pickColor(harness.ctx, km, "cyan"), "blue");
	assert.match(harness.renders.at(-1)!.lines.join("\n"), /l move.*y choose.*x cancel/);
	assertWidthBounded(harness.renders);
});

test("workbench honors configured package back and injected cancel with effective width-bounded hints", async () => {
	const { km, manager } = keymap({
		"tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "y", "tui.select.cancel": "x",
		"pi-subagent-supervisor.back": "q",
	});
	const harness = scriptedContext(manager, [["q"], ["x"]], [20, 24, 80]);
	assert.equal(await openAgentWorkbench(harness.ctx, km, { kind: "create" }), undefined);
	assert.equal(harness.renders.length, 6, "configured back opens a second workbench stage view before cancel");
	const wide = harness.renders.find((render) => render.width === 80)!;
	assert.match(wide.lines.join("\n"), /q +back[\s\S]*x +discard[\s\S]*y +edit \/ next[\s\S]*k\/j +select/);
	assertWidthBounded(harness.renders);
});

test("workbench renders the effective suggestion binding without generating a suggestion", () => {
	const draft = createAgentDraft();
	for (const width of [20, 24, 80]) {
		const lines = renderWorkbench(draft, { stage: 3, selected: 0 }, width, { kind: "create" }, {
			up: "k", down: "j", confirm: "y", cancel: "x", suggest: "s", back: "q",
		});
		assert.match(lines.join("\n"), width === 80 ? /s  Want a suggestion\?/ : /s  Want a suggest/);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});
