import type { AgentConfig } from "./agents.ts";

/** Normalize an agent's name and description into a stable single-line bullet for
 * the subagents block. Collapses any internal newlines, tabs, and runs of whitespace
 * so the output never wraps across multiple lines even when the agent's description
 * has been authored with line breaks. */
export function formatAgentBullet(agent: AgentConfig): string {
	const name = agent.name.trim().replace(/\s+/g, " ");
	const desc = agent.description.replace(/\s+/g, " ").trim();
	return `- ${name}: ${desc}`;
}

/** Build the system-prompt block that advertises the available subagents so the
 * main model auto-delegates. Agent-agnostic by design: the routing intelligence
 * lives in each agent's `description` (rebuilt from disk every turn), so this text
 * never names a specific agent and never goes stale when agents are added/removed.
 * Returns "" when there are none. */
export function buildActiveAgentsBlock(agents: AgentConfig[]): string {
	const active = agents.filter((a) => a.auto);
	if (active.length === 0) return "";
	return [
		"",
		"# Available subagents",
		"These advertised specialists run in separate, fresh, uncached sessions. Delegate only when their routing contracts justify that cost.",
		"A capability specialist owns the portion that creates or edits its claimed file type, framework, or toolchain, even inside a mixed task. A coordinating implementer owns the remaining edits and integration.",
		"Known failures stay with the diagnosis/fix coordinator from reproduction through final verification; capability specialists own only their delegated edits and validation.",
		"Tests belong to a test specialist when tests are the requested artifact, a TDD-first flow needs an expected red, or a coordinator requests one warranted focused regression. Routine suite-running and generic test selection stay with the implementer.",
		"Static review covers the final combined implementation-and-test diff after edits settle and before completion or commit. It complements rather than replaces focused verification.",
		"A planning request produces and presents a plan, then STOP. Continue to implementation only when the same original user message explicitly requested both planning and implementation; otherwise wait for later explicit approval. A request to implement an existing plan does not need planning again.",
		"Use recon only when several unfamiliar files must be traced; do a named-file or named-symbol lookup inline. Keep small, nameable edits inline; delegate implementation when coordination, edit/build churn, or context cost makes isolation worthwhile.",
		"When 2+ already-justified delegated tasks are independent—neither needs another output, overlaps reads or edits, or changes shared state—batch them in one parallel call so a slow branch does not idle ready work. Do not split work merely to manufacture parallelism, duplicate investigation, pair implementation with its review or verification, or overlap writers.",
		"Agents absent from this advertised roster are not proactive options, but an agent explicitly named by the user may still be invoked without exposing hidden identities here.",
		"When contracts overlap, known-failure ownership controls the flow; an explicit capability specialist owns its claimed edit; the coordinator owns integration and final verification. Test and review ownership then follow the lifecycle above. An agent description's NOT-for boundaries override this generic guidance.",
		"Ask for concise results with file:line evidence. Follow each routing contract literally:",
		...active.map(formatAgentBullet),
		"",
	].join("\n");
}
