import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../src/agents.ts";
import { countActiveExecutions, dashboardAgentIdentity, floorDashboardElapsed, openDashboard, startDashboardElapsedTimer } from "../src/dashboard.ts";
import { Keymap } from "../src/keymap.ts";
import { outputContractChoice } from "../src/output-editor.ts";
import { RETURNS_PRESETS } from "../src/result-view.ts";

const agent = (name: string): AgentConfig => ({
	name,
	description: `${name} routing description`,
	fallback: [],
	auto: true,
	readonly: false,
	color: "cyan",
	conventions: false,
	spawn: [],
	systemPrompt: "",
	source: "user",
	filePath: `/tmp/${name}.md`,
});

assert.deepEqual(dashboardAgentIdentity({ ...agent("worker"), displayName: "Ada" }), { primary: "Ada", role: "worker" });
assert.deepEqual(dashboardAgentIdentity(agent("reviewer")), { primary: "reviewer", role: undefined });
assert.equal(floorDashboardElapsed(29_999), 20_000);

const activeNode = (id: number, role = "worker"): any => ({
	id,
	callId: 1,
	role,
	persona: { base: role, friendDepth: 0 },
	color: "cyan",
	task: "work",
	status: "active",
	plannedAt: 1,
	startedAt: 1,
	durationMs: 10,
	usage: {},
	contextPercent: null,
	activity: { type: "tool", at: 2, tool: "read", text: "file.ts" },
	toolLog: [],
	ownCost: 0,
	subtreeCost: 0,
	children: [],
});
const snapshot = (roots: any[]): any => ({
	id: 1,
	mode: "parallel",
	launchSurface: "foreground",
	revision: 1,
	createdAt: 1,
	durationMs: 10,
	counts: { total: roots.length, dormant: 0, active: roots.length, finished: 0, failed: 0 },
	totalCost: 0,
	roots,
});
assert.equal(countActiveExecutions([snapshot([activeNode(1), activeNode(2)])]), 2, "duplicate runs for one role count separately");

// The focused overlay refreshes at elapsed bucket boundaries only.
{
	let now = 25_001;
	let snapshots: any[] = [snapshot([activeNode(1)])];
	let scheduled: { callback: () => void; delay: number; canceled: boolean } | undefined;
	let refreshes = 0;
	const timer = startDashboardElapsedTimer(
		() => snapshots,
		() => { refreshes++; },
		() => now,
		(callback, delay) => (scheduled = { callback, delay, canceled: false }) as any,
		(handle: any) => { handle.canceled = true; },
	);
	assert.equal(scheduled?.delay, 5_000, "timer waits for the next displayed bucket");
	now += 5_000;
	scheduled!.callback();
	assert.equal(refreshes, 1);
	assert.equal(scheduled?.delay, 10_000, "active work schedules the next bucket");
	const activeHandle = scheduled!;
	snapshots = [];
	timer.reset();
	assert.equal(activeHandle.canceled, true);
	const noWorkHandle = scheduled;
	timer.dispose();
	assert.equal(scheduled, noWorkHandle, "inactive work does not schedule a timer");
}

// Exercise the rendered component. This uses the strongest stable component seam.
{
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.editor.cursorLeft": "l", "tui.editor.cursorRight": "r",
		"tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "c", "tui.select.cancel": "x",
		"pi-subagent-supervisor.toggle": "a", "pi-subagent-supervisor.contract": "c", "pi-subagent-supervisor.preview": "p", "pi-subagent-supervisor.help": "h",
	} as any);
	const km = new Keymap({ getKeybinds: () => ({}) } as any);
	let component: any;
	let registryListener = () => {};
	let snapshots: any[] = [snapshot([activeNode(1), activeNode(2)])];
	let renders = 0;
	const focus: boolean[] = [];
	const ctx = {
		cwd: "/tmp/dashboard-render-test",
		isProjectTrusted: () => false,
		ui: {
			custom: async (factory: any) => {
				let completed: any;
				component = factory(
					{ requestRender: () => { renders++; } },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					keybindings,
					(result: any) => { completed = result; },
				);
				for (const width of [20, 24, 80]) {
					component.invalidate();
					assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width), `dashboard fits width ${width}`);
				}
				const wide = component.render(120);
				assert.ok(wide.every((line: string) => visibleWidth(line) <= 120));
				assert.match(wide.join("\n"), /Subagent Studio · 2 roles · 2 active executions · 0 staged routing changes/);
				assert.match(wide.join("\n"), /Roles \/ live state[\s\S]*Role configuration[\s\S]*Output contract/);
				assert.match(wide.join("\n"), /Routing · AUTO · model may route/);
				assert.match(wide.join("\n"), /Contract: Findings[\s\S]*Latest \/ live status[\s\S]*Latest: done · 12s/);
				component.handleInput("j");
				const writerSelection = component.render(120).join("\n");
				assert.match(writerSelection, /Routing · AUTO/);
				assert.match(writerSelection, /Contract: None/, "selection updates configuration and output panels");
				component.handleInput("k");
				assert.match(component.render(120).join("\n"), /Contract: Findings/);

				component.handleInput("c");
				const editorWide = component.render(120).join("\n");
				assert.match(editorWide, /Output Contract editor[\s\S]*Contract   Findings/);
				assert.match(editorWide, /Sample output[\s\S]*Readable[\s\S]*Exact JSON/);
				component.handleInput("r");
				const reviewSample = component.render(120).join("\n");
				assert.match(reviewSample, /Contract   Review/);
				assert.match(reviewSample, /Verdict: approve/);
				for (const width of [20, 24, 80, 120]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width), `output editor fits width ${width}`);
				component.handleInput("p");
				assert.match(component.render(80).join("\n"), /Output & status 3\/3[\s\S]*Sample output/, "narrow editor exposes its preview pane");
				component.handleInput("p");
				component.handleInput("c");
				const outputReview = component.render(120).join("\n");
				assert.match(outputReview, /Review[\s\S]*Markdown frontmatter outcome[\s\S]*returns:/);
				assert.match(outputReview, /\{"type":"object","required"/);
				assert.match(outputReview, /resultView: exact/);
				assert.match(outputReview, /Ready to save/);
				component.handleInput("c");
				assert.match(component.render(120).join("\n"), /Save Output Contract\?.*c again/);
				component.handleInput("b");
				assert.match(component.render(120).join("\n"), /Output Contract editor[\s\S]*Edit/);
				component.handleInput("x");
				assert.doesNotMatch(component.render(120).join("\n"), /Output Contract draft/, "discard returns to Studio without a save");

				component.handleInput("c");
				component.handleInput("r");
				component.handleInput("r");
				component.handleInput("r");
				assert.match(component.render(120).join("\n"), /Contract   Custom[\s\S]*Fields · ordered[\s\S]*No fields yet/);
				for (const [name, typeCycles] of [["summary", 0], ["score", 1], ["tags", 3]] as const) {
					component.handleInput("n");
					component.handleInput(name);
					component.handleInput("c");
					for (let cycle = 0; cycle < typeCycles; cycle++) component.handleInput("r");
				}
				component.handleInput("k");
				component.handleInput("k");
				component.handleInput("a");
				const customEditor = component.render(120).join("\n");
				assert.match(customEditor, /summary · string · required[\s\S]*score · number · optional[\s\S]*tags · string-list · optional/);
				assert.match(customEditor, /Sample output[\s\S]*example summary[\s\S]*"score": 1[\s\S]*"tags"/);
				for (const width of [20, 24, 80, 120]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width), `guided Custom fits width ${width}`);
				component.handleInput("n");
				component.handleInput("discarded");
				component.handleInput("x");
				assert.doesNotMatch(component.render(120).join("\n"), /discarded/, "cancel naming keeps the draft in memory without adding a row");
				component.handleInput("c");
				assert.match(component.render(120).join("\n"), /Review[\s\S]*returns:[\s\S]*summary[\s\S]*score[\s\S]*tags/);
				component.handleInput("b");
				component.handleInput("x");
				assert.doesNotMatch(component.render(120).join("\n"), /Output Contract draft/, "canceling the whole guided editor performs no save");

				component.handleInput("a");
				assert.match(component.render(120).join("\n"), /Routing · MANUAL/);
				component.handleInput("h");
				assert.match(component.render(120).join("\n"), /Role actions[\s\S]*configure[\s\S]*open source[\s\S]*stage auto-routing change[\s\S]*Studio actions[\s\S]*cc +apply staged[\s\S]*new role[\s\S]*preferences/);
				component.handleInput("h");
				component.handleInput("c");
				assert.match(component.render(120).join("\n"), /Apply staged auto-routing changes\?.*c again/);
				component.handleInput("z");

				const narrowList = component.render(80).join("\n");
				assert.match(narrowList, /Roles 1\/3 · l\/r switch view[\s\S]*Roles \/ live state/);
				component.handleInput("r");
				const narrowConfigure = component.render(80).join("\n");
				assert.match(narrowConfigure, /Configure 2\/3[\s\S]*Role configuration[\s\S]*Actions/);
				component.handleInput("r");
				const narrowOutput = component.render(80).join("\n");
				assert.match(narrowOutput, /Output & status 3\/3[\s\S]*Output contract[\s\S]*Latest \/ live status/);
				component.render(120);
				component.render(80);
				assert.match(component.render(80).join("\n"), /Output & status/, "resize preserves narrow view and selection");

				snapshots = [];
				const before = renders;
				registryListener();
				assert.equal(renders, before + 1);
				assert.match(component.render(80).join("\n"), /No active execution/, "live completion updates the open status view");
				component.handleInput("x");
				assert.match(component.render(80).join("\n"), /Discard staged auto-routing changes\?.*x again/);
				component.handleInput("x");
				assert.equal(completed.exit.kind, "cancel", "second configured cancel closes without applying staged changes");
				return completed;
			},
			notify() {},
		},
	} as any;
	await openDashboard(ctx, {
		state: { getShowCosts: () => false, getResultView: () => "readable" } as any,
		registry: {
			onChange: (listener: () => void) => { registryListener = listener; return () => {}; },
			activeCallSnapshots: () => snapshots,
		} as any,
		km,
		liveSurface: { setDashboardFocused: (value) => focus.push(value) },
		runStats: () => new Map(),
		latestRuns: () => new Map([["worker", { ts: "2026-01-01T00:00:00.000Z", agent: "worker", mode: "single", status: "done", durationMs: 12_000, cost: 0, input: 1, output: 1, tools: 1, task: "latest task" }]]),
		discover: () => [{ ...agent("worker"), returns: RETURNS_PRESETS[0].schema, resultView: "exact" }, agent("writer")],
	});
	assert.deepEqual(focus, [true, false]);
}

// Shared Contract/Preview/Confirm dispatch keeps editor entry, review, and two-press save semantics.
{
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.editor.cursorRight": "r", "tui.select.confirm": "c", "tui.select.cancel": "x",
		"pi-subagent-supervisor.contract": "c", "pi-subagent-supervisor.preview": "c",
	} as any);
	const km = new Keymap({ getKeybinds: () => ({}) } as any);
	let studioScreens = 0;
	let saves = 0;
	let savedDraft: any;
	const ctx = {
		cwd: "/tmp/studio-output-save-test",
		isProjectTrusted: () => false,
		ui: {
			custom: async (factory: any) => {
				studioScreens++;
				let completed: any;
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					keybindings,
					(result: any) => { completed = result; },
				);
				if (studioScreens === 1) {
					component.handleInput("c");
					assert.match(component.render(80).join("\n"), /Configure 2\/3[\s\S]*Output Contract editor/, "Contract wins the idle Confirm collision");
					component.handleInput("r");
					component.handleInput("c");
					assert.match(component.render(120).join("\n"), /Review[\s\S]*Ready to save/, "edit Confirm wins its Preview collision");
					component.handleInput("c");
					assert.equal(saves, 0, "the first save confirmation does not write");
					assert.match(component.render(120).join("\n"), /Save Output Contract\?/, "review Confirm wins its Preview collision");
					component.handleInput("c");
				} else {
					assert.match(component.render(120).join("\n"), /Contract: Findings/, "Studio rediscovers after save");
					component.handleInput("x");
					component.handleInput("x");
				}
				return completed;
			},
			notify() {},
		},
	} as any;
	await openDashboard(ctx, {
		state: { getShowCosts: () => false, getResultView: () => "readable" } as any,
		registry: { onChange: () => () => {}, activeCallSnapshots: () => [] } as any,
		km,
		liveSurface: { setDashboardFocused() {} },
		discover: () => [{ ...agent("worker"), returns: RETURNS_PRESETS[0].schema }],
		persistOutput: (_selected, draft) => { saves++; savedDraft = draft; },
	});
	assert.equal(saves, 1);
	assert.equal(outputContractChoice(savedDraft), "Review");
	assert.equal(studioScreens, 2);
}

// Configure and New use focused screens, then rediscover and return to the same Studio selection.
{
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.confirm": "c", "tui.select.cancel": "x",
	} as any);
	const km = new Keymap({ getKeybinds: () => ({}) } as any);
	let studioScreens = 0;
	let discoveries = 0;
	let configured = 0;
	let created = 0;
	const ctx = {
		cwd: "/tmp/studio-return-test",
		isProjectTrusted: () => false,
		ui: {
			custom: async (factory: any) => {
				studioScreens++;
				let completed: any;
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					keybindings,
					(result: any) => { completed = result; },
				);
				assert.match(component.render(120).join("\n"), /worker/);
				if (studioScreens === 1) component.handleInput("e");
				else if (studioScreens === 2) component.handleInput("n");
				else { component.handleInput("x"); component.handleInput("x"); }
				return completed;
			},
			notify() {},
		},
	} as any;
	await openDashboard(ctx, {
		state: { getShowCosts: () => false, getResultView: () => "readable" } as any,
		registry: { onChange: () => () => {}, activeCallSnapshots: () => [] } as any,
		km,
		liveSurface: { setDashboardFocused() {} },
		discover: () => { discoveries++; return [agent("worker"), agent("writer")]; },
		editWorkbench: async (_ctx, _km, selected) => {
			configured++;
			assert.equal(selected.name, "worker");
			return { oldName: "worker", newName: "worker", auto: true };
		},
		newWorkbench: async () => { created++; },
	});
	assert.equal(configured, 1);
	assert.equal(created, 1);
	assert.equal(studioScreens, 3);
	assert.ok(discoveries >= 3, "Studio rediscovers after each focused workbench returns");
}

console.log("dashboard presentation unit tests passed");
