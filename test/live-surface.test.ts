import assert from "node:assert/strict";
import { Loader, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../src/agents.ts";
import { emptyUsage } from "../src/engine.ts";
import { formatBackgroundCompletion, formatLiveIndicator, formatLiveSummary, formatLiveSurface, LiveSurfaceCoordinator, type LiveSurfaceUi, type TimerAdapter } from "../src/live-surface.ts";
import { createPersona, createRootPersonas } from "../src/persona.ts";
import { RunRegistry } from "../src/registry.ts";

const plain = (text: string | undefined): string | undefined => text?.replace(/\x1b\[[0-9:;]*m/g, "");

function renderLoaderFrame(frame: string, width: number): string[] {
	const loader = new Loader({ requestRender() {} } as never, (text) => text, (text) => text, "", { frames: [frame] });
	const lines = loader.render(width);
	loader.stop();
	return lines;
}

interface EffectiveSgr {
	foreground: string;
	intensity: "normal" | "bold" | "dim";
}

function applySgr(state: EffectiveSgr, parametersText: string): void {
	const parameters = parametersText === "" ? ["0"] : parametersText.split(";");
	for (let index = 0; index < parameters.length; index += 1) {
		const parameter = parameters[index];
		const colonParts = parameter.split(":");
		const code = Number(colonParts[0]);
		if (code === 0) {
			state.foreground = "default";
			state.intensity = "normal";
		} else if (code === 1) state.intensity = "bold";
		else if (code === 2) state.intensity = "dim";
		else if (code === 22) state.intensity = "normal";
		else if (code === 39) state.foreground = "default";
		else if (code === 38 && colonParts.length > 1) {
			const components = colonParts.slice(2).filter((part) => part !== "");
			state.foreground = colonParts[1] === "2"
				? `rgb(${components.slice(0, 3).join(",")})`
				: `indexed(${components[0]})`;
		} else if (code === 38) {
			const mode = Number(parameters[index + 1]);
			if (mode === 2) {
				state.foreground = `rgb(${parameters.slice(index + 2, index + 5).join(",")})`;
				index += 4;
			} else if (mode === 5) {
				state.foreground = `indexed(${parameters[index + 2]})`;
				index += 2;
			}
		} else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
			state.foreground = `ansi(${code})`;
		}
	}
}

function effectiveSgrAt(lines: readonly string[], lineIndex: number, target: string): EffectiveSgr {
	const state: EffectiveSgr = { foreground: "default", intensity: "normal" };
	for (let currentLine = 0; currentLine <= lineIndex; currentLine += 1) {
		const line = lines[currentLine];
		const targetOffset = currentLine === lineIndex ? plain(line)?.indexOf(target) ?? -1 : Number.POSITIVE_INFINITY;
		if (currentLine === lineIndex && targetOffset < 0) throw new Error(`missing target ${target}`);
		let visibleOffset = 0;
		for (let rawOffset = 0; rawOffset < line.length;) {
			const sgr = /^\x1b\[([0-9:;]*)m/.exec(line.slice(rawOffset));
			if (sgr) {
				applySgr(state, sgr[1]);
				rawOffset += sgr[0].length;
				continue;
			}
			if (currentLine === lineIndex && visibleOffset === targetOffset) return { ...state };
			const character = String.fromCodePoint(line.codePointAt(rawOffset)!);
			rawOffset += character.length;
			visibleOffset += character.length;
		}
	}
	throw new Error(`target ${target} was not reached`);
}

function effectiveSgrAtLineEnd(lines: readonly string[], lineIndex: number): EffectiveSgr {
	const sentinel = "__sgr_line_end__";
	const withSentinel = lines.map((line, index) => index === lineIndex ? `${line}${sentinel}` : line);
	return effectiveSgrAt(withSentinel, lineIndex, sentinel);
}

const agent = (name: string, displayName = name): AgentConfig =>
	({
		name,
		displayName,
		description: "",
		color: "cyan",
		readonly: false,
		conventions: false,
		spawn: [],
		fallback: [],
		systemPrompt: "",
		source: "user",
		filePath: `/tmp/${name}.md`,
	}) as AgentConfig;

class FakeTimers implements TimerAdapter {
	readonly intervals = new Map<number, () => void>();
	readonly delays: number[] = [];
	readonly cleared: number[] = [];
	unrefCount = 0;
	private nextId = 1;

	setInterval(callback: () => void, delayMs: number) {
		const id = this.nextId++;
		this.intervals.set(id, callback);
		this.delays.push(delayMs);
		return {
			id,
			unref: () => {
				this.unrefCount += 1;
			},
		};
	}

	clearInterval(handle: { id: number }): void {
		this.cleared.push(handle.id);
		this.intervals.delete(handle.id);
	}

	tick(): void {
		for (const callback of [...this.intervals.values()]) callback();
	}
}

class FakeUi implements LiveSurfaceUi {
	readonly working: Array<string | undefined> = [];
	readonly indicators: Array<{ frames?: string[]; intervalMs?: number } | undefined> = [];
	readonly statuses: Array<{ key: string; text: string | undefined }> = [];
	readonly notices: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];

	setWorkingMessage(message?: string): void {
		this.working.push(message);
	}

	setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void {
		this.indicators.push(options);
	}

	setStatus(key: string, text: string | undefined): void {
		this.statuses.push({ key, text });
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notices.push({ message, type });
	}
}

const finish = (
	call: ReturnType<RunRegistry["createCall"]>,
	runId: number,
	ok = true,
): void => {
	call.finish(runId, {
		ok,
		finalText: ok ? "done" : "",
		error: ok ? undefined : "boom",
		usage: { ...emptyUsage(), cost: 0.0121 },
		contextPercent: null,
	});
	call.finishCall({ ok, error: ok ? undefined : "boom" });
};

// A configured display name and assigned task are user-controlled. Pi's Loader
// receives the uncut rows and wraps them at the actual terminal width.
{
	const registry = new RunRegistry({ now: () => 0 });
	const verbose = agent("worker", "Ada ".repeat(80));
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const runId = call.planRoot(verbose, "work ".repeat(80), createPersona(verbose));
	call.start(runId);
	const surface = formatLiveSurface(registry.activeCallSnapshots(0));
	assert.ok(surface);
	assert.ok(visibleWidth(surface.split("\n")[1]) > 75, "formatting must not guess a narrow terminal width");
	for (const line of renderLoaderFrame(formatLiveIndicator(registry.activeCallSnapshots(0)).frames[0], 30)) {
		assert.ok(visibleWidth(line) <= 30, `Pi's Loader must own wrapping at its actual width: ${line}`);
	}
	assert.match(plain(surface)!, /^subagents go!\n/);
	assert.doesNotMatch(surface, /active|finished|dormant|\$|calls/);
}

// Explicit instruction line breaks remain visible while the live surface runs;
// tool activity annotates only the first instruction row.
{
	const registry = new RunRegistry({ now: () => 0 });
	const worker = agent("worker", "Ada");
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const runId = call.planRoot(worker, "Task:\ninspect alpha\n\nreview beta", createPersona(worker));
	call.start(runId);
	call.applyEvent(runId, { type: "tool", name: "read", argsPreview: "read hidden/path.ts" });

	const snapshot = registry.activeCallSnapshots(0);
	assert.equal(plain(formatLiveSurface(snapshot)), [
		"subagents go!",
		"● Ada · worker · tinkering · 0:00",
		"   used read! · inspect alpha",
		"   ",
		"   review beta",
	].join("\n"));
	assert.equal((plain(formatLiveIndicator(snapshot).frames[0]).match(/used read!/g) ?? []).length, 1);
}

// A nested spawn is allocated and started through the same events used by
// tool.ts's tracked runner. The safe streaming projection is a vertical tree
// with role/persona, assigned task, and terse tool activity, but no arguments.
{
	const registry = new RunRegistry({ now: () => 0 });
	const parent = agent("worker", "Ada");
	const child = agent("scout", "Grace");
	child.color = "purple";
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const parentId = call.planRoot(parent, "coordinate the investigation", createPersona(parent));
	call.start(parentId);
	call.applyEvent(parentId, { type: "tool", name: "subagent", argsPreview: "subagent SECRET child task" });
	const childId = call.spawnChild(parentId, child, "trace the registry", createPersona(child));
	call.start(childId);
	call.applyEvent(childId, { type: "tool", name: "read", argsPreview: "read SECRET/path.ts" });
	call.applyEvent(childId, { type: "usage", usage: emptyUsage(), contextPercent: 5 });

	const snapshot = registry.activeCallSnapshots(0)[0];
	assert.equal(snapshot.counts.active, 2, "registry snapshot must contain the live descendant");
	assert.equal(snapshot.roots[0].children[0].activity.tool, "read", "later usage events retain the last concrete tool");
	assert.equal(formatLiveSummary([snapshot]), "Grace spelunking 0:00", "the footer names the child doing work, not its blocked parent");
	const surface = formatLiveSurface([snapshot]);
	assert.equal(plain(surface), [
		"subagents go!",
		"○ Ada · worker · waiting for scout · 0:00",
		"│  coordinate the investigation",
		"╰─ ● Grace · scout · spelunking · 0:00",
		"      used read! · trace the registry",
	].join("\n"));
	assert.doesNotMatch(surface!, /SECRET|used subagent/, "generic parent activity and tool arguments stay hidden");
	assert.match(surface!, /\x1b\[38;2;95;199;196m(?:╰─|│|●|Ada)/, "configured color reaches smooth nesting rails, status, and identity");
	const indicator = formatLiveIndicator([snapshot]);
	assert.equal(indicator.frames.length, 10, "the loading glyph keeps all ten Braille frames");
	assert.equal(
		indicator.frames.length * indicator.intervalMs!,
		1_000,
		"one loading-glyph loop aligns with the coordinator's one-second duration refresh",
	);
	assert.equal(plain(indicator.frames[0]).split("\n")[0], "subagents go!", "the heading has no loader");
	assert.equal((plain(indicator.frames[0]).match(/⠋/g) ?? []).length, 1, "only the child doing work has a loader");
	assert.match(plain(indicator.frames[0]), /╰─ ⠋ Grace · scout · spelunking · 0:00/);
	assert.equal((plain(indicator.frames[1]).match(/⠙/g) ?? []).length, 1, "Pi receives animated braille frames");
	for (const line of renderLoaderFrame(indicator.frames[0], 80).filter((line) => line.length > 0)) {
		assert.equal(visibleWidth(line), 80, "the Loader applies its real width and one-column side padding");
	}

	call.finish(childId, {
		ok: true,
		finalText: "done",
		usage: emptyUsage(),
		contextPercent: null,
	});
	assert.equal(plain(formatLiveSurface(registry.activeCallSnapshots(0))), [
		"subagents go!",
		"● Ada · worker · tinkering · 0:00",
		"│  coordinate the investigation",
		"╰─ ✓ Grace · scout · 0:00",
		"      used read! · trace the registry",
	].join("\n"), "a parent resumes working after its descendant completes");
}

// Loader wrapping isolates every configured-color identity and dim activity
// row, without leaking either style into the row that follows it.
{
	const loaderWidth = 32;
	const registry = new RunRegistry({ now: () => 0 });
	const parent = agent("worker", "Ada");
	const firstChild = agent("scout", "Grace Hopper ".repeat(5).trim());
	const nextChild = agent("reviewer", "Lin");
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const parentId = call.planRoot(parent, "coordinate", createPersona(parent));
	call.start(parentId);
	const firstId = call.spawnChild(
		parentId,
		firstChild,
		"trace verbose nested activity across every wrapped continuation line",
		createPersona(firstChild),
	);
	const nextId = call.spawnChild(parentId, nextChild, "review", createPersona(nextChild));
	call.start(firstId);
	call.start(nextId);
	call.applyEvent(firstId, { type: "tool", name: "read", argsPreview: "read hidden/path.ts" });

	const rendered = renderLoaderFrame(
		formatLiveIndicator(registry.activeCallSnapshots(0), loaderWidth).frames[0],
		loaderWidth,
	);
	const firstIdentityIndex = rendered.findIndex((line) => plain(line)?.includes("├─ ⠋ Grace"));
	const nextIdentityIndex = rendered.findIndex((line) => plain(line)?.includes("Lin · reviewer"));
	assert.ok(firstIdentityIndex >= 0, "the first nested child identity must reach Loader");
	assert.ok(nextIdentityIndex > firstIdentityIndex, "the following sibling identity must reach Loader after the first child");
	const taskStartIndex = rendered.findIndex((line, index) =>
		index > firstIdentityIndex && /^ │ {5}\S/.test(plain(line) ?? ""));
	assert.ok(taskStartIndex > firstIdentityIndex, "the activity row must follow the wrapped identity");
	const identityLines = rendered.slice(firstIdentityIndex, taskStartIndex).filter((line) => line.trim().length > 0);
	const taskLines = rendered.slice(taskStartIndex, nextIdentityIndex).filter((line) => line.trim().length > 0);
	assert.ok(identityLines.length > 1, "the configured-color name must wrap onto multiple physical identity rows");
	assert.ok(taskLines.length > 1, "the concrete activity/task must wrap before the following sibling");
	assert.ok(
		taskLines.every((line) => /^ │ {5}\S/.test(plain(line) ?? "")),
		"every wrapped task line must retain Loader's side padding plus the six-column nested gutter",
	);
	assert.ok(
		rendered.every((line) => visibleWidth(line) <= loaderWidth),
		`every Loader line must fit width ${loaderWidth}`,
	);
	const cyanNormal: EffectiveSgr = { foreground: "rgb(95,199,196)", intensity: "normal" };
	const defaultNormal: EffectiveSgr = { foreground: "default", intensity: "normal" };
	const mutedBody: EffectiveSgr = { foreground: "default", intensity: "dim" };
	assert.deepEqual(
		identityLines.map((line) => effectiveSgrAtLineEnd([line], 0)),
		identityLines.map(() => defaultNormal),
		"every physical configured-color identity row must end at default foreground and normal intensity",
	);
	assert.deepEqual(
		taskLines.map((line) => effectiveSgrAt([line], 0, (plain(line) ?? "")[7])),
		taskLines.map(() => mutedBody),
		"every wrapped activity body must retain the same effective muted foreground and intensity after the identity boundary",
	);
	assert.deepEqual(
		taskLines.map((line) => effectiveSgrAt([line], 0, "│")),
		taskLines.map(() => cyanNormal),
		"every wrapped activity connector must use configured cyan at normal intensity",
	);
	assert.deepEqual({
		connector: effectiveSgrAt(rendered, nextIdentityIndex, "╰─"),
		status: effectiveSgrAt(rendered, nextIdentityIndex, "⠋"),
		name: effectiveSgrAt(rendered, nextIdentityIndex, "Lin"),
		role: effectiveSgrAt(rendered, nextIdentityIndex, "reviewer"),
	}, {
		connector: cyanNormal,
		status: cyanNormal,
		name: cyanNormal,
		role: cyanNormal,
	}, "the following sibling connector, spinner, name, and role must each be configured cyan at normal intensity");
	assert.deepEqual(
		taskLines.map((line) => effectiveSgrAtLineEnd([line], 0)),
		taskLines.map(() => defaultNormal),
		"every physical activity row must end with isolated default SGR state",
	);
	console.log("Loader wrapped ANSI identity/activity/sibling regression passed (12 assertions)");
}

// Multiple children share a continuous parent-colored stem, with a rounded
// final branch and task rows that do not steal the name-to-name connection.
{
	const registry = new RunRegistry({ now: () => 0 });
	const parent = agent("worker", "Ada");
	const firstChild = agent("scout", "Grace");
	const lastChild = agent("reviewer", "Lin");
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const parentId = call.planRoot(parent, "coordinate", createPersona(parent));
	call.start(parentId);
	const firstId = call.spawnChild(parentId, firstChild, "inspect", createPersona(firstChild));
	const lastId = call.spawnChild(parentId, lastChild, "review", createPersona(lastChild));
	call.start(firstId);
	call.start(lastId);
	assert.equal(plain(formatLiveSurface(registry.activeCallSnapshots(0))), [
		"subagents go!",
		"○ Ada · worker · waiting for 2 subagents · 0:00",
		"│  coordinate",
		"├─ ● Grace · scout · spelunking · 0:00",
		"│     inspect",
		"╰─ ● Lin · reviewer · scrutineering · 0:00",
		"      review",
	].join("\n"));
}

// Waiting follows unfinished work through terminal middle nodes, so an active
// ancestor never regains a spinner while a deeper descendant still owns work.
{
	const registry = new RunRegistry({ now: () => 0 });
	const parent = agent("worker", "Ada");
	const middle = agent("scout", "Grace");
	const leaf = agent("reviewer", "Lin");
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const parentId = call.planRoot(parent, "coordinate", createPersona(parent));
	call.start(parentId);
	const middleId = call.spawnChild(parentId, middle, "delegate", createPersona(middle));
	call.start(middleId);
	const leafId = call.spawnChild(middleId, leaf, "review", createPersona(leaf));
	call.start(leafId);
	call.finish(middleId, { ok: true, finalText: "delegated", usage: emptyUsage(), contextPercent: null });
	const snapshot = registry.activeCallSnapshots(0)[0];
	assert.equal(formatLiveSummary([snapshot]), "Lin scrutineering 0:00");
	assert.match(plain(formatLiveSurface([snapshot]))!, /○ Ada · worker · waiting for reviewer · 0:00/);
	assert.equal((plain(formatLiveIndicator([snapshot]).frames[0]).match(/⠋/g) ?? []).length, 1);
}

// Pi's fullscreen layout measures the working indicator inside its bottom dock.
// A multiline or wrapped indicator grows that dock until it displaces the
// transcript, so foreground progress must use Pi's one-line footer status.
{
	const registry = new RunRegistry({ now: () => 0 });
	const timers = new FakeTimers();
	const ui = new FakeUi();
	const coordinator = new LiveSurfaceCoordinator({ registry, getUi: () => ui, now: () => 0, timers });
	const worker = agent("worker", "Ada ".repeat(40).trim());
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const runId = call.planRoot(worker, "work", createPersona(worker));
	call.start(runId);

	assert.equal(ui.statuses.at(-1)?.key, "subagent-activity", "activity must sort before the lower-priority cost status");
	assert.ok(visibleWidth(ui.statuses.at(-1)?.text ?? "") <= 75, "footer progress must keep its conservative width bound");
	assert.equal(ui.working.length, 0, "fullscreen progress must not claim Pi's wrapping working row");
	assert.equal(ui.indicators.length, 0, "the coordinator must not overwrite another extension's working indicator");
	coordinator.dispose();
}

// Removing lazy timer ownership would either tick forever while idle or create
// one interval per call. One coordinator owns exactly one one-second interval.
{
	let now = 1_000;
	const registry = new RunRegistry({ now: () => now });
	const timers = new FakeTimers();
	const ui = new FakeUi();
	const coordinator = new LiveSurfaceCoordinator({
		registry,
		getUi: () => ui,
		now: () => now,
		timers,
	});
	assert.equal(timers.intervals.size, 0);

	const worker = agent("worker", "Ada");
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const runId = call.planRoot(worker, "work", createPersona(worker));
	assert.equal(timers.intervals.size, 1);
	assert.deepEqual(timers.delays, [1_000]);
	assert.equal(timers.unrefCount, 1);
	assert.equal(ui.statuses.at(-1)?.text, "Ada waiting");
	assert.equal(ui.indicators.length, 0, "foreground work must not overwrite the working indicator");

	call.start(runId);
	let transcriptInvalidations = 0;
	const stopTranscriptClock = coordinator.subscribeRenderer(() => transcriptInvalidations++);
	const writesAfterStart = ui.statuses.length;
	call.applyEvent(runId, { type: "status", status: "still working" });
	assert.equal(ui.statuses.length, writesAfterStart, "unchanged formatted text must not touch the UI");
	assert.equal(transcriptInvalidations, 0, "registry events must not drive the transcript clock");

	now = 1_999;
	timers.tick();
	assert.equal(ui.statuses.length, writesAfterStart);
	assert.equal(transcriptInvalidations, 1, "the existing one-second timer invalidates subscribed renderers once");
	now = 2_000;
	timers.tick();
	assert.equal(ui.statuses.length, writesAfterStart + 1);
	assert.equal(transcriptInvalidations, 2);
	stopTranscriptClock();
	assert.equal(ui.statuses.at(-1)?.text, "Ada tinkering 0:01");

	finish(call, runId);
	assert.equal(timers.intervals.size, 0);
	assert.deepEqual(timers.cleared, [1]);
	assert.equal(ui.statuses.at(-1)?.text, undefined, "finishing must clear the owned footer status");
	assert.equal(ui.working.length, 0, "the coordinator must never claim the working message");
	assert.equal(ui.indicators.length, 0, "the coordinator must never mutate the working indicator");
	assert.deepEqual(ui.notices, [], "foreground completion is already visible in its transcript signal");
	coordinator.dispose();
}

// All live work belongs to one extension-owned footer key. Foreground overlap
// updates the aggregate there, and dashboard focus suppresses it without losing
// the state needed for immediate restoration.
{
	let now = 20_000;
	const registry = new RunRegistry({ now: () => now });
	const timers = new FakeTimers();
	const ui = new FakeUi();
	const coordinator = new LiveSurfaceCoordinator({
		registry,
		getUi: () => ui,
		now: () => now,
		timers,
	});
	const scout = agent("scout", "Grace");
	const background = registry.createCall({ mode: "chain", launchSurface: "background" });
	const backgroundId = background.planRoot(scout, "review", createPersona(scout));
	background.start(backgroundId);
	assert.deepEqual(ui.statuses.at(-1), {
		key: "subagent-activity",
		text: "Grace spelunking 0:00",
	});

	const worker = agent("worker", "Ada");
	const foreground = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const foregroundId = foreground.planRoot(worker, "edit", createPersona(worker));
	foreground.start(foregroundId);
	assert.equal(ui.statuses.at(-1)?.text, "Grace spelunking 0:00 + Ada tinkering 0:00");
	assert.equal(ui.working.length, 0);
	assert.equal(ui.indicators.length, 0);

	coordinator.setDashboardFocused(true);
	assert.deepEqual(ui.statuses.at(-1), { key: "subagent-activity", text: undefined });
	const suppressedWrites = ui.statuses.length;
	now += 10_000;
	timers.tick();
	assert.equal(ui.statuses.length, suppressedWrites);

	coordinator.setDashboardFocused(false);
	assert.equal(ui.statuses.at(-1)?.text, "Grace spelunking 0:10 + Ada tinkering 0:10");

	finish(foreground, foregroundId);
	assert.equal(ui.statuses.at(-1)?.text, "Grace spelunking 0:10");
	finish(background, backgroundId, false);
	assert.equal(ui.notices.length, 1, "one background call must produce one completion notice");
	assert.equal(ui.notices[0].type, "error");
	assert.match(ui.notices[0].message, /^Grace failed · 0:10$/);
	coordinator.dispose();
}

// A foreground slash-command call can run while Pi is idle. It uses the same
// sole footer key without being reclassified as background or gaining a
// completion toast.
{
	let now = 40_000;
	const registry = new RunRegistry({ now: () => now });
	const timers = new FakeTimers();
	const ui = new FakeUi();
	const activity: Array<{ active: boolean; leaseId: string }> = [];
	const coordinator = new LiveSurfaceCoordinator({
		registry,
		getUi: () => ui,
		now: () => now,
		timers,
		onActiveChange: (change) => activity.push(change),
	});
	const worker = agent("worker", "Ada");
	const call = registry.createCall({ mode: "single", launchSurface: "foreground" });
	const runId = call.planRoot(worker, "slash command", createPersona(worker));
	call.start(runId);
	assert.deepEqual(activity.map(({ active }) => active), [true], "pane integrations receive one aggregate working transition");
	assert.equal(ui.statuses.at(-1)?.text, "Ada tinkering 0:00");
	assert.equal(ui.working.length, 0);
	assert.equal(ui.indicators.length, 0);

	finish(call, runId);
	assert.deepEqual(activity.map(({ active }) => active), [true, false], "pane integrations return idle when the call settles");
	assert.equal(activity[0].leaseId, activity[1].leaseId, "one coordinator balances a stable lease ID");
	assert.deepEqual(ui.notices, []);
	assert.equal(ui.statuses.at(-1)?.text, undefined);
	coordinator.dispose();
}

// Disposal stops UI ownership immediately, but an already-running background
// call may survive /reload. Its Herdr lifecycle must drain to the real finish
// instead of publishing a false idle transition at shutdown.
{
	let now = 50_000;
	const registry = new RunRegistry({ now: () => now });
	const timers = new FakeTimers();
	const ui = new FakeUi();
	const activity: Array<{ active: boolean; leaseId: string }> = [];
	const coordinator = new LiveSurfaceCoordinator({
		registry,
		getUi: () => ui,
		now: () => now,
		timers,
		onActiveChange: (change) => activity.push(change),
	});
	const worker = agent("worker", "Ada");
	const call = registry.createCall({ mode: "single", launchSurface: "background" });
	const runId = call.planRoot(worker, "work", createPersona(worker));
	call.start(runId);
	assert.deepEqual(activity.map(({ active }) => active), [true]);

	const beforeDispose = ui.working.length;
	coordinator.dispose();
	assert.equal(timers.intervals.size, 0);
	assert.deepEqual(activity.map(({ active }) => active), [true], "reload disposal must not report idle while detached work survives");
	assert.equal(ui.working.length, beforeDispose, "background disposal does not claim the streaming surface");
	assert.deepEqual(ui.statuses.at(-1), { key: "subagent-activity", text: undefined });

	const afterDispose = ui.working.length + ui.statuses.length + ui.notices.length;
	finish(call, runId);
	assert.deepEqual(activity.map(({ active }) => active), [true, false], "the detached lifecycle closes when surviving work really finishes");
	assert.equal(activity[0].leaseId, activity[1].leaseId, "surviving work releases the original coordinator lease");
	assert.equal(ui.working.length + ui.statuses.length + ui.notices.length, afterDispose, "draining activity never reclaims disposed UI");
	registry.createCall({ mode: "single", launchSurface: "background" });
	timers.tick();
	assert.equal(ui.working.length + ui.statuses.length + ui.notices.length, afterDispose);
}

// Parallel work names every root—including stable same-role friend identities—
// instead of hiding them behind an aggregate count.
{
	const registry = new RunRegistry({ now: () => 0 });
	const ada = agent("worker", "Ada");
	const grace = agent("reviewer", "Grace");
	const agents = [ada, ada, grace];
	const personas = createRootPersonas("parallel", agents);
	const call = registry.createCall({ mode: "parallel", launchSurface: "foreground" });
	agents.forEach((entry, index) => call.planRoot(entry, "work", personas[index]));
	assert.equal(formatLiveSummary(registry.activeCallSnapshots(0)), "Ada waiting + Ada’s friend waiting + Grace waiting");
	assert.equal(plain(formatLiveSurface(registry.activeCallSnapshots(0))), [
		"subagents go!",
		"○ Ada · worker · waiting",
		"   work",
		"○ Ada’s friend · worker · waiting",
		"   work",
		"○ Grace · reviewer · waiting",
		"   work",
	].join("\n"));

	const longRegistry = new RunRegistry({ now: () => 0 });
	const longAgents = Array.from({ length: 18 }, (_, index) => agent(`role-${index}`, `Verbose identity ${index}`));
	const longPersonas = createRootPersonas("parallel", longAgents);
	const longCall = longRegistry.createCall({ mode: "parallel", launchSurface: "foreground" });
	const longIds = longAgents.map((entry, index) => longCall.planRoot(entry, "work", longPersonas[index]));
	const longTree = formatLiveSurface(longRegistry.activeCallSnapshots(0)) ?? "";
	for (const line of renderLoaderFrame(formatLiveIndicator(longRegistry.activeCallSnapshots(0)).frames[0], 80)) {
		assert.ok(visibleWidth(line) <= 80, `the live tree must defer to the Loader's actual width: ${line}`);
	}
	assert.match(longTree, /^subagents go!/);
	assert.equal(
		plain(longTree)?.split("\n").filter((line) => /○ Verbose identity \d+/.test(line)).length,
		18,
		"the live tree retains every parallel root instead of aggregating a large call",
	);
	const longDurationLine = formatLiveSummary(longRegistry.activeCallSnapshots(6_000_000)) ?? "";
	assert.ok(visibleWidth(longDurationLine) <= 75, `long footer summaries must retain the live-line bound: ${longDurationLine}`);
	assert.doesNotMatch(longDurationLine, /100:00/, "dormant agents must not inherit call wall time");
	assert.match(longDurationLine, /waiting/);
	assert.match(longDurationLine, /15 more$/);
	longCall.start(longIds[0]);
	longCall.start(longIds[1]);
	longCall.start(longIds[2]);
	longCall.start(longIds[3]);
	const longActiveSummary = formatLiveSummary(longRegistry.activeCallSnapshots(1_000_000_000_000)) ?? "";
	assert.ok(visibleWidth(longActiveSummary) <= 75, `active footer must stay bounded: ${longActiveSummary}`);
	assert.match(longActiveSummary, /more$/, "footer overflow remains explicit when long states force fewer identities");

	const repeatedRegistry = new RunRegistry({ now: () => 0 });
	const repeatedAgents = Array.from({ length: 6 }, () => ada);
	const repeatedPersonas = createRootPersonas("parallel", repeatedAgents);
	const repeatedCall = repeatedRegistry.createCall({ mode: "parallel", launchSurface: "foreground" });
	repeatedAgents.forEach((entry, index) => repeatedCall.planRoot(entry, "work", repeatedPersonas[index]));
	assert.equal(
		formatLiveSummary(repeatedRegistry.activeCallSnapshots(0)),
		"Ada waiting + Ada’s friend waiting + Ada ×3 waiting + 3 more",
	);
}

// A sequence names its unfinished roots and drops completed identities as the
// active step advances, rather than permanently inheriting the first persona.
{
	let now = 70_000;
	const registry = new RunRegistry({ now: () => now });
	const timers = new FakeTimers();
	const ui = new FakeUi();
	const coordinator = new LiveSurfaceCoordinator({
		registry,
		getUi: () => ui,
		now: () => now,
		timers,
	});
	const grace = agent("reviewer", "Grace");
	const ada = agent("worker", "Ada");
	const call = registry.createCall({ mode: "chain", launchSurface: "background" });
	const first = call.planRoot(grace, "review", createPersona(grace));
	const second = call.planRoot(ada, "implement", createPersona(ada));
	assert.equal(ui.statuses.at(-1)?.text, "Grace waiting");

	call.start(first);
	assert.equal(ui.statuses.at(-1)?.text, "Grace scrutineering 0:00");
	call.finish(first, {
		ok: true,
		finalText: "reviewed",
		usage: emptyUsage(),
		contextPercent: null,
	});
	assert.equal(ui.statuses.at(-1)?.text, "Ada waiting");

	call.start(second);
	assert.equal(ui.statuses.at(-1)?.text, "Ada tinkering 0:00");
	coordinator.dispose();
}

// Footer fallback follows the actual active descendant rather than presenting a
// finished parent with its frozen duration as if it were still working.
{
	const registry = new RunRegistry({ now: () => 0 });
	const parent = agent("worker", "Ada");
	const child = agent("scout", "Grace");
	const call = registry.createCall({ mode: "single", launchSurface: "background" });
	const parentId = call.planRoot(parent, "coordinate", createPersona(parent));
	call.start(parentId);
	const childId = call.spawnChild(parentId, child, "inspect", createPersona(child));
	call.start(childId);
	call.finish(parentId, {
		ok: true,
		finalText: "parent done",
		usage: emptyUsage(),
		contextPercent: null,
	});
	assert.equal(formatLiveSummary(registry.activeCallSnapshots(0)), "Grace spelunking 0:00");
}

// Completion notices follow the same dynamic preference while the heartbeat never has a price.
{
	const registry = new RunRegistry({ now: () => 0 });
	const call = registry.createCall({ mode: "single", launchSurface: "background" });
	const runId = call.planRoot(agent("worker", "Ada"), "work", createPersona(agent("worker", "Ada")));
	call.start(runId);
	finish(call, runId);
	const done = registry.getCallSnapshot(call.id);
	assert.ok(done);
	assert.doesNotMatch(formatBackgroundCompletion(done!, false).message, /\$/);
	assert.match(formatBackgroundCompletion(done!, true).message, /\$0\.0121/);
}

console.log("live surface unit tests passed");
