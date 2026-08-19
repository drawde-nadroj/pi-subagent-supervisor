import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { colorize } from "./colors.ts";
import { formatLiteralPersona, formatPersona } from "./persona.ts";
import type { RunNodeSnapshot, RunNodeStatus } from "./registry.ts";

export interface AgentTreeTheme {
	muted(text: string): string;
}

export interface TreePosition {
	ancestors: ReadonlyArray<{ color: string; last: boolean }>;
	last: boolean;
}

export interface AgentRowOptions {
	showTokens?: boolean;
	optionalDetails?: readonly string[];
	activeGlyph?: string;
	/** Whether active rows include their projected live elapsed duration. */
	showActiveDuration?: boolean;
}

export function formatAgentDuration(ms: number, active = false): string {
	const materialized = active ? Math.floor(Math.max(0, ms) / 1_000) * 1_000 : Math.max(0, ms);
	const seconds = Math.floor(materialized / 1_000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function agentStatusGlyph(status: RunNodeStatus): string {
	switch (status) {
		case "dormant": return "○";
		case "active": return "●";
		case "success": return "✓";
		case "error": return "✗";
		case "aborted": return "⊘";
	}
}

const ROLE_ACTIVITY: Readonly<Record<string, string>> = {
	debugger: "exorcising",
	oracle: "divining",
	planner: "scheming",
	reviewer: "scrutineering",
	scout: "spelunking",
	"test-writer": "tripwiring",
	worker: "tinkering",
	"tldraw-offline": "doodling",
};

export function activityForRole(role: string): string {
	return ROLE_ACTIVITY[role] ?? "working";
}

function ancestorPrefix(ancestors: TreePosition["ancestors"]): string {
	return ancestors
		.map(({ color, last }) => last ? "   " : `${colorize(color, "│")}  `)
		.join("");
}

/** Keep a node's branch open while content that leads to children is shown. */
export function agentContentPrefix(node: RunNodeSnapshot, position: TreePosition, hasChildren: boolean): string {
	const continuation = hasChildren ? colorize(node.color, "│") : " ";
	return `${ancestorPrefix(position.ancestors)}${continuation}  `;
}

function identityPrefix(node: RunNodeSnapshot, position: TreePosition): string {
	if (position.ancestors.length === 0) return "";
	const parent = position.ancestors[position.ancestors.length - 1];
	const prefix = ancestorPrefix(position.ancestors.slice(0, -1));
	return `${prefix}${colorize(parent?.color ?? node.color, position.last ? "╰─" : "├─")} `;
}

export function childTreePosition(position: TreePosition, node: RunNodeSnapshot, last: boolean): TreePosition {
	return {
		ancestors: [...position.ancestors, { color: node.color, last }],
		last,
	};
}

/** A role identical to the fallback persona carries no additional information. */
function distinctRole(node: Pick<RunNodeSnapshot, "role" | "persona">): string | undefined {
	if (!node.role) return undefined;
	return node.persona.friendDepth > 0 || node.persona.base !== node.role ? node.role : undefined;
}

function blockingDescendants(node: RunNodeSnapshot): RunNodeSnapshot[] {
	return node.children.flatMap((child) =>
		child.status === "active" || child.status === "dormant"
			? [child]
			: blockingDescendants(child));
}

export function agentIsWaiting(node: RunNodeSnapshot): boolean {
	return node.status === "active" && blockingDescendants(node).length > 0;
}

function statusText(node: RunNodeSnapshot, showActiveDuration = true): string {
	const duration = showActiveDuration ? ` · ${formatAgentDuration(node.durationMs, true)}` : "";
	const blockers = blockingDescendants(node);
	if (node.status === "active" && blockers.length === 1) {
		return `waiting for ${blockers[0].role || "subagent"}${duration}`;
	}
	if (node.status === "active" && blockers.length > 1) {
		return `waiting for ${blockers.length} subagents${duration}`;
	}
	if (node.status === "dormant") return "waiting";
	if (node.status === "active") return `${activityForRole(node.role)}${duration}`;
	if (node.status === "error") return `error · ${formatAgentDuration(node.durationMs)}`;
	if (node.status === "aborted") return `aborted · ${formatAgentDuration(node.durationMs)}`;
	return formatAgentDuration(node.durationMs);
}

export function formatAgentIdentityLine(
	node: RunNodeSnapshot,
	position: TreePosition,
	theme: AgentTreeTheme,
	width: number,
	options: AgentRowOptions = {},
): string {
	const prefix = identityPrefix(node, position);
	const statusGlyph = agentIsWaiting(node)
		? agentStatusGlyph("dormant")
		: node.status === "active" && options.activeGlyph
			? options.activeGlyph
			: agentStatusGlyph(node.status);
	const glyph = `${colorize(node.color, statusGlyph)} `;
	const role = distinctRole(node);
	const state = ` · ${theme.muted(statusText(node, options.showActiveDuration !== false))}`;
	const tokens = options.showTokens && node.status !== "active" && node.status !== "dormant"
		? ` · ${theme.muted(`↑${node.usage.input} ↓${node.usage.output}`)}`
		: "";
	let roleField = role ? `${theme.muted(" · ")}${colorize(node.color, role)}` : "";
	const details = [...(options.optionalDetails ?? [])].map((detail) => ` · ${theme.muted(detail)}`);
	const literal = formatLiteralPersona(node.persona);
	const identity = (name: string): string => `${glyph}${colorize(node.color, name)}${roleField}${state}${details.join("")}${tokens}`;
	const compose = (name: string): string => `${prefix}${identity(name)}`;
	while (details.length > 0 && visibleWidth(compose(literal)) > width) details.pop();
	if (visibleWidth(compose(literal)) > width) roleField = "";
	const fixedWidth = visibleWidth(`${prefix}${identity("")}`);
	const name = formatPersona(node.persona, Math.max(1, width - fixedWidth));
	return truncateToWidth(compose(name), Math.max(1, width));
}

export function conciseAgentTask(task: string): string {
	return task
		.replace(/^Task:\s*/i, "")
		.replace(/^Read-only (?:inspection|review|work) only; do not edit files\.\s*/i, "")
		.replace(/^Do not edit files\.\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function conciseLiveAgentTaskLines(task: string): string[] {
	const lines = task
		.replace(/^Task:\s*/i, "")
		.replace(/^Read-only (?:inspection|review|work) only; do not edit files\.\s*/i, "")
		.replace(/^Do not edit files\.\s*/i, "")
		.split(/\r\n|\r|\n/)
		.map((line) => line.replace(/[^\S\r\n]+/g, " ").trim());
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines.length > 0 ? lines : ["(no assigned task)"];
}

export function concreteAgentActivity(node: RunNodeSnapshot): string | undefined {
	if (node.status === "dormant") return undefined;
	const tool = node.activity.tool?.trim();
	return tool && tool !== "subagent" ? `used ${tool}!` : undefined;
}

export function formatAgentTaskLine(
	node: RunNodeSnapshot,
	position: TreePosition,
	hasChildren: boolean,
	theme: AgentTreeTheme,
	width: number,
): string {
	const prefix = agentContentPrefix(node, position, hasChildren);
	const activity = concreteAgentActivity(node);
	const task = conciseAgentTask(node.task) || "(no assigned task)";
	const body = activity ? `${activity} · ${task}` : task;
	return truncateToWidth(`${prefix}${theme.muted(body)}`, Math.max(1, width));
}

export function formatLiveAgentTaskLines(
	node: RunNodeSnapshot,
	position: TreePosition,
	hasChildren: boolean,
	theme: AgentTreeTheme,
	width: number,
): string[] {
	const prefix = agentContentPrefix(node, position, hasChildren);
	const activity = concreteAgentActivity(node);
	return conciseLiveAgentTaskLines(node.task).map((task, index) => {
		const body = index === 0 && activity ? `${activity} · ${task}` : task;
		return truncateToWidth(`${prefix}${theme.muted(body)}`, Math.max(1, width));
	});
}
