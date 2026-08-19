import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import { countActiveExecutions, dashboardAgentIdentity, floorDashboardElapsed, openDashboard, startDashboardElapsedTimer } from "./dashboard.ts";

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
				component = factory(
					{ requestRender: () => { renders++; } },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					() => {},
				);
				const wide = component.render(120);
				assert.ok(wide.every((line: string) => visibleWidth(line) <= 120));
				assert.match(wide.join("\n"), /roles · 2 active executions · 0 staged routing changes/);
				assert.match(wide.join("\n"), /Routing · AUTO · model may route/);
				component.handleInput("A");
				assert.match(component.render(120).join("\n"), /Routing · MANUAL · slash command or current-turn explicit name/);
				assert.match(wide.join("\n"), /Live activity/);

				const narrowList = component.render(80).join("\n");
				assert.match(narrowList, /List · use right to show detail/);
				component.handleInput("R");
				const narrowDetail = component.render(80).join("\n");
				assert.match(narrowDetail, /Detail · use left to show list/);
				assert.match(narrowDetail, /Recent stats · 30 days/);
				component.render(120);
				component.render(80);
				assert.match(component.render(80).join("\n"), /Detail/, "resize preserves narrow view and selection");

				snapshots = [];
				const before = renders;
				registryListener();
				assert.equal(renders, before + 1);
				assert.match(component.render(80).join("\n"), /Quiet/, "live completion updates the open inspector");
				component.dispose();
				return { exit: { kind: "cancel" }, auto: new Map(), selected: "worker" };
			},
			notify() {},
		},
	} as any;
	await openDashboard(ctx, {
		state: { getShowCosts: () => false } as any,
		registry: {
			onChange: (listener: () => void) => { registryListener = listener; return () => {}; },
			activeCallSnapshots: () => snapshots,
		} as any,
		km: {
			matches: (action: string, data: string) => ({ left: "L", right: "R", toggle: "A" } as any)[action] === data,
			label: (action: string) => action,
		} as any,
		liveSurface: { setDashboardFocused: (value) => focus.push(value) },
		runStats: () => new Map(),
	});
	assert.deepEqual(focus, [true, false]);
}

console.log("dashboard presentation unit tests passed");
