import { randomUUID } from "node:crypto";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dim } from "./colors.ts";
import type { CallSnapshot, RunNodeSnapshot, RunRegistry } from "./registry.ts";
import { formatLiteralPersona, formatPersona } from "./persona.ts";
import {
	activityForRole,
	agentIsWaiting,
	childTreePosition,
	formatAgentDuration,
	formatAgentIdentityLine,
	formatLiveAgentTaskLines,
	type TreePosition,
} from "./tree-presentation.ts";

// Pi sorts footer statuses by key; activity must precede the lower-priority cost segment.
const LIVE_STATUS_KEY = "subagent-activity";
const LIVE_INTERVAL_MS = 1_000;
const FOOTER_SURFACE_WIDTH = 75;
// Footer statuses are one physical line and Pi does not expose their render
// width. Reserve enough room for each identity at the conservative bound.
const MAX_LIVE_IDENTITIES = 4;
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BRAILLE_INTERVAL_MS = 100;

export interface LiveSurfaceUi {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface TimerHandle {
	unref?(): void;
}

export interface TimerAdapter {
	setInterval(callback: () => void, delayMs: number): TimerHandle;
	clearInterval(handle: TimerHandle): void;
}

export interface ActiveLeaseChange {
	active: boolean;
	leaseId: string;
}

const HERDR_WORKING_LEASES = Symbol.for("herdr.pi.working-leases");
const HERDR_WORKING_LEASE_LISTENERS = Symbol.for("herdr.pi.working-lease-listeners");

type HerdrLeaseGlobals = typeof globalThis & {
	[HERDR_WORKING_LEASES]?: Set<string>;
	[HERDR_WORKING_LEASE_LISTENERS]?: Set<(change: ActiveLeaseChange) => void>;
};

export function publishHerdrWorkingLease(change: ActiveLeaseChange): void {
	const shared = globalThis as HerdrLeaseGlobals;
	const leases = shared[HERDR_WORKING_LEASES] ??= new Set<string>();
	if (change.active) leases.add(change.leaseId);
	else leases.delete(change.leaseId);
	for (const listener of shared[HERDR_WORKING_LEASE_LISTENERS] ?? []) listener(change);
}

export function bridgeHerdrWorkingLease(
	events: { emit(name: string, data: ActiveLeaseChange): void },
	change: ActiveLeaseChange,
): void {
	// The process-global lease is authoritative across /reload. Update it
	// before using the runtime emitter, which may belong to the old binding.
	publishHerdrWorkingLease(change);
	events.emit("herdr:working", change);
}

export interface LiveSurfaceOptions {
	registry: RunRegistry;
	getUi: () => LiveSurfaceUi | undefined;
	now?: () => number;
	timers?: TimerAdapter;
	/** Routine completion notices follow the persisted cost preference. */
	showCosts?: () => boolean;
	/** Aggregate activity transition for integrations that track pane-level work. */
	onActiveChange?: (change: ActiveLeaseChange) => void;
}

const productionTimers: TimerAdapter = {
	setInterval(callback, delayMs) {
		const native = globalThis.setInterval(callback, delayMs);
		return {
			unref: () => native.unref(),
			native,
		} as TimerHandle;
	},
	clearInterval(handle) {
		const native = (handle as TimerHandle & { native: ReturnType<typeof globalThis.setInterval> }).native;
		globalThis.clearInterval(native);
	},
};

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function activeWork(snapshots: readonly CallSnapshot[]): CallSnapshot[] {
	return snapshots.filter((snapshot) => snapshot.counts.active + snapshot.counts.dormant > 0);
}

function visibleRoots(snapshot: CallSnapshot): RunNodeSnapshot[] {
	if (snapshot.mode !== "chain") return snapshot.roots;
	const visible = snapshot.roots.filter((root) => root.status !== "dormant");
	const next = snapshot.roots.find((root) => root.status === "dormant");
	if (next) visible.push(next);
	return visible;
}

function activeSummaryNodes(nodes: readonly RunNodeSnapshot[]): RunNodeSnapshot[] {
	return nodes.flatMap((node) => [
		...(node.status === "active" && !agentIsWaiting(node) ? [node] : []),
		...activeSummaryNodes(node.children),
	]);
}

function dormantSummaryNodes(nodes: readonly RunNodeSnapshot[]): RunNodeSnapshot[] {
	return nodes.flatMap((node) => [
		...(node.status === "dormant" ? [node] : []),
		...dormantSummaryNodes(node.children),
	]);
}

function visibleSummaryRoots(snapshot: CallSnapshot): RunNodeSnapshot[] {
	const active = activeSummaryNodes(snapshot.roots);
	if (active.length > 0) return active;
	const dormant = dormantSummaryNodes(snapshot.roots);
	return snapshot.mode === "parallel" ? dormant : dormant.slice(0, 1);
}

const liveTreeTheme = { muted: dim };
const RESET_STYLE = "\x1b[0m";

function isolateAnsiLines(lines: readonly string[]): string[] {
	return lines.map((line) => `${RESET_STYLE}${line}${RESET_STYLE}`);
}

function liveIdentityLines(line: string, width: number): string[] {
	return isolateAnsiLines(Number.isFinite(width) ? wrapTextWithAnsi(line, width) : [line]);
}

function liveTaskLines(node: RunNodeSnapshot, position: TreePosition, hasChildren: boolean, width: number): string[] {
	const logicalLines = formatLiveAgentTaskLines(node, position, hasChildren, liveTreeTheme, Number.POSITIVE_INFINITY);
	if (!Number.isFinite(width)) return isolateAnsiLines(logicalLines);
	const gutterWidth = position.ancestors.length * 3 + 3;
	if (width <= gutterWidth) {
		return isolateAnsiLines(logicalLines.map((line) => truncateToWidth(line, Math.max(1, width))));
	}
	return isolateAnsiLines(logicalLines.flatMap((line) => {
		const lineWidth = visibleWidth(line);
		const prefix = sliceByColumn(line, 0, gutterWidth);
		const body = sliceByColumn(line, gutterWidth, Math.max(0, lineWidth - gutterWidth));
		return wrapTextWithAnsi(body, width - gutterWidth).map((part) => `${prefix}${part}`);
	}));
}

function appendLiveTree(
	lines: string[],
	node: RunNodeSnapshot,
	position: TreePosition,
	activeGlyph: string | undefined,
	width: number,
): void {
	// Pre-wrap at Loader's content width so hanging gutters survive, then isolate
	// every physical row because Text otherwise carries open SGR state across
	// literal newlines before adding its side padding.
	lines.push(...liveIdentityLines(formatAgentIdentityLine(node, position, liveTreeTheme, Number.POSITIVE_INFINITY, {
		activeGlyph,
	}), width));
	lines.push(...liveTaskLines(node, position, node.children.length > 0, width));
	node.children.forEach((child, index) => {
		appendLiveTree(lines, child, childTreePosition(position, node, index === node.children.length - 1), activeGlyph, width);
	});
}

/**
 * Format the safe streaming surface as a vertical call tree. Pi's working
 * indicator is below the transcript and accepts newlines; changing it redraws
 * that bottom component without invalidating the transcript tool row.
 */
export function formatLiveSurface(
	snapshots: readonly CallSnapshot[],
	activeGlyph?: string,
	loaderWidth = Number.POSITIVE_INFINITY,
): string | undefined {
	const active = activeWork(snapshots);
	if (active.length === 0) return undefined;
	const roots = active.flatMap(visibleRoots);
	const lines = ["subagents go!"];
	const contentWidth = Number.isFinite(loaderWidth) ? Math.max(1, loaderWidth - 2) : loaderWidth;
	roots.forEach((root, index) => appendLiveTree(
		lines,
		root,
		{ ancestors: [], last: index === roots.length - 1 },
		activeGlyph,
		contentWidth,
	));
	return lines.join("\n");
}

function indicatorSurface(snapshots: readonly CallSnapshot[], activeGlyph: string | undefined, loaderWidth: number): string {
	return formatLiveSurface(snapshots, activeGlyph, loaderWidth) ?? "subagents go!";
}

/** Full animated frames let Pi place a braille loader on every active row. */
export function formatLiveIndicator(
	snapshots: readonly CallSnapshot[],
	loaderWidth = Number.POSITIVE_INFINITY,
): { frames: string[]; intervalMs?: number } {
	const hasActiveNode = snapshots.some((snapshot) => activeSummaryNodes(snapshot.roots).length > 0);
	if (!hasActiveNode) return { frames: [indicatorSurface(snapshots, undefined, loaderWidth)] };
	return {
		frames: BRAILLE_FRAMES.map((frame) => indicatorSurface(snapshots, frame, loaderWidth)),
		intervalMs: BRAILLE_INTERVAL_MS,
	};
}

/** Pi's built-in footer explicitly renders extension statuses on one line. */
export function formatLiveSummary(snapshots: readonly CallSnapshot[]): string | undefined {
	const active = activeWork(snapshots);
	if (active.length === 0) return undefined;
	const nodes = active.flatMap(visibleSummaryRoots);
	const separator = " + ";
	let shownCount = nodes.length > MAX_LIVE_IDENTITIES
		? MAX_LIVE_IDENTITIES - 1
		: nodes.length;
	while (shownCount > 1) {
		const shown = nodes.slice(0, shownCount);
		const states = shown.map((node) => node.status === "dormant"
			? "waiting"
			: `${activityForRole(node.role)} ${formatAgentDuration(node.durationMs, true)}`);
		const overflowLabel = nodes.length > shownCount ? `${separator}${nodes.length - shownCount} more` : "";
		const reserved = visibleWidth(overflowLabel)
			+ visibleWidth(separator) * Math.max(0, shownCount - 1)
			+ states.reduce((sum, state) => sum + visibleWidth(` ${state}`), 0);
		if (reserved + shownCount <= FOOTER_SURFACE_WIDTH) break;
		shownCount -= 1;
	}
	const shown = nodes.slice(0, shownCount);
	const overflow = nodes.length - shown.length;
	const overflowLabel = overflow > 0 ? `${separator}${overflow} more` : "";
	const states = shown.map((node) => node.status === "dormant"
		? "waiting"
		: `${activityForRole(node.role)} ${formatAgentDuration(node.durationMs, true)}`);
	const reserved = visibleWidth(overflowLabel)
		+ visibleWidth(separator) * Math.max(0, shown.length - 1)
		+ states.reduce((sum, state) => sum + visibleWidth(` ${state}`), 0);
	const itemWidth = Math.max(1, Math.floor((FOOTER_SURFACE_WIDTH - reserved) / shown.length));
	const summary = shown.map((node, index) => `${formatPersona(node.persona, itemWidth)} ${states[index]}`).join(separator) + overflowLabel;
	return truncateToWidth(summary, FOOTER_SURFACE_WIDTH);
}

/** Format one terminal notification for background call ownership. */
export function formatBackgroundCompletion(snapshot: CallSnapshot, showCosts = false): {
	message: string;
	type: "info" | "error";
} {
	const label = snapshot.roots.length === 1
		? formatLiteralPersona(snapshot.roots[0].persona)
		: "Subagents";
	const failed = snapshot.ok === false || snapshot.counts.failed > 0;
	const failureCount = snapshot.counts.failed > 1 ? ` · ${snapshot.counts.failed} failed` : "";
	return {
		message: `${label} ${failed ? "failed" : "finished"} · ${formatDuration(snapshot.durationMs)}${showCosts ? ` · $${snapshot.totalCost.toFixed(4)}` : ""}${failureCount}`,
		type: failed ? "error" : "info",
	};
}

/**
 * Projects the registry's active call graph onto one safe bottom surface.
 *
 * Clock ticks only re-read registry snapshots and touch one footer status.
 * This module deliberately has no transcript renderer, tool-update, message,
 * or invalidation dependency, keeping Pi's inline scrollback event-driven.
 */
export class LiveSurfaceCoordinator {
	private readonly registry: RunRegistry;
	private readonly getUi: () => LiveSurfaceUi | undefined;
	private readonly now: () => number;
	private readonly timers: TimerAdapter;
	private readonly showCosts: () => boolean;
	private readonly onActiveChange: (change: ActiveLeaseChange) => void;
	private readonly leaseId = `subagents:${randomUUID()}`;
	private readonly unsubscribeChange: () => void;
	private readonly unsubscribeFinish: () => void;
	private timer?: TimerHandle;
	private dashboardFocused = false;
	private disposed = false;
	private footerOwned = false;
	private footerText?: string;
	private ownedUi?: LiveSurfaceUi;
	private active = false;
	private readonly rendererInvalidators = new Set<() => void>();

	constructor(options: LiveSurfaceOptions) {
		this.registry = options.registry;
		this.getUi = options.getUi;
		this.now = options.now ?? Date.now;
		this.timers = options.timers ?? productionTimers;
		this.showCosts = options.showCosts ?? (() => false);
		this.onActiveChange = options.onActiveChange ?? (() => {});
		this.unsubscribeChange = this.registry.onChange(() => this.handleRegistryChange());
		this.unsubscribeFinish = this.registry.onCallFinish((snapshot) => this.notifyCompletion(snapshot));
		this.refresh();
	}

	setDashboardFocused(focused: boolean): void {
		if (this.disposed || this.dashboardFocused === focused) return;
		this.dashboardFocused = focused;
		this.refresh();
	}

	/** Share the coordinator's sole clock with live transcript components. */
	subscribeRenderer(invalidate: () => void): () => void {
		if (this.disposed) return () => {};
		this.rendererInvalidators.add(invalidate);
		return () => this.rendererInvalidators.delete(invalidate);
	}

	refresh(): void {
		if (this.disposed) return;
		const snapshots = activeWork(this.registry.activeCallSnapshots(this.now()));
		const active = snapshots.length > 0;
		if (active !== this.active) {
			this.active = active;
			this.onActiveChange({ active, leaseId: this.leaseId });
		}
		if (snapshots.length > 0) this.ensureTimer();
		else this.stopTimer();

		if (this.dashboardFocused || snapshots.length === 0) {
			this.clearOwnedSurfaces();
			return;
		}

		const text = formatLiveSummary(snapshots);
		if (!text) {
			this.clearOwnedSurfaces();
			return;
		}
		// The built-in footer status is always one physical line. Pi's fullscreen
		// working row wraps and expands its bottom dock, so live progress must not
		// claim that surface or mutate its indicator.
		this.showFooter(text);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeFinish();
		this.stopTimer();
		this.rendererInvalidators.clear();
		this.clearOwnedSurfaces();
		// Fire-and-forget background calls can outlive /reload. Keep only the
		// registry transition needed to close their external activity lifecycle;
		// reporting false here would make Herdr idle while that work still runs.
		if (!this.active) this.unsubscribeChange();
	}

	private handleRegistryChange(): void {
		if (!this.disposed) {
			this.refresh();
			return;
		}
		if (!this.active || activeWork(this.registry.activeCallSnapshots(this.now())).length > 0) return;
		this.active = false;
		this.onActiveChange({ active: false, leaseId: this.leaseId });
		this.unsubscribeChange();
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = this.timers.setInterval(() => {
			this.refresh();
			for (const invalidate of [...this.rendererInvalidators]) invalidate();
		}, LIVE_INTERVAL_MS);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (!this.timer) return;
		this.timers.clearInterval(this.timer);
		this.timer = undefined;
	}

	private showFooter(text: string): void {
		const ui = this.getUi();
		if (!ui) return;
		if (this.footerOwned && this.footerText === text && this.ownedUi === ui) return;
		if (this.footerOwned && this.ownedUi !== ui) this.ownedUi?.setStatus(LIVE_STATUS_KEY, undefined);
		ui.setStatus(LIVE_STATUS_KEY, text);
		this.ownedUi = ui;
		this.footerOwned = true;
		this.footerText = text;
	}

	private clearOwnedSurfaces(): void {
		if (this.footerOwned) this.ownedUi?.setStatus(LIVE_STATUS_KEY, undefined);
		this.footerOwned = false;
		this.footerText = undefined;
		this.ownedUi = undefined;
	}

	private notifyCompletion(snapshot: CallSnapshot): void {
		if (this.disposed || snapshot.launchSurface !== "background") return;
		const ui = this.getUi();
		if (!ui) return;
		const notice = formatBackgroundCompletion(snapshot, this.showCosts());
		ui.notify(notice.message, notice.type);
	}
}
