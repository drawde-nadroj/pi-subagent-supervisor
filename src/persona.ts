import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentDisplayName, type AgentConfig } from "./agents.ts";

/**
 * A serializable, launch-time snapshot of a run's human-facing identity.
 * The durable role remains outside this descriptor so routing and persistence
 * never accidentally use a persona name.
 */
export interface PersonaDescriptor {
	base: string;
	friendDepth: number;
}

type PersonaAgent = Pick<AgentConfig, "name" | "displayName">;
export type PersonaRootMode = "single" | "parallel" | "sequence";

/** Snapshot an agent's configured display name, falling back to its durable role. */
export function createPersona(agent: PersonaAgent): PersonaDescriptor {
	return { base: agentDisplayName(agent), friendDepth: 0 };
}

/**
 * Snapshot personas for a call's top-level roots. Only explicit parallel roots
 * share friend-depth counters, and those counters are deliberately role-based.
 */
export function createRootPersonas(mode: PersonaRootMode, agents: readonly PersonaAgent[]): PersonaDescriptor[] {
	if (mode !== "parallel") return agents.map(createPersona);
	const depths = new Map<string, number>();
	return agents.map((agent) => {
		const friendDepth = depths.get(agent.name) ?? 0;
		depths.set(agent.name, friendDepth + 1);
		return { base: agentDisplayName(agent), friendDepth };
	});
}

/**
 * Preserve a branch persona when a role delegates to itself. A different role
 * begins a fresh snapshot from its own configured display name.
 */
export function createNestedPersona(parent: { role: string; persona: PersonaDescriptor }, child: PersonaAgent): PersonaDescriptor {
	if (parent.role === child.name) return { base: parent.persona.base, friendDepth: parent.persona.friendDepth };
	return createPersona(child);
}

/** Render the deterministic, fully expanded friend chain. */
export function formatLiteralPersona(persona: PersonaDescriptor): string {
	return persona.base + "’s friend".repeat(Math.max(0, persona.friendDepth));
}

/**
 * Fit a persona in the available row width without truncating the semantic
 * friend suffix. Wide rows use the literal chain; compact rows use ×N; only a
 * last-resort narrow row clips the base itself.
 */
export function formatPersona(persona: PersonaDescriptor, width: number): string {
	const literal = formatLiteralPersona(persona);
	if (visibleWidth(literal) <= width) return literal;
	if (persona.friendDepth === 0) return truncateToWidth(persona.base, Math.max(0, width));

	const suffix = `’s friend ×${persona.friendDepth}`;
	const compact = persona.base + suffix;
	if (visibleWidth(compact) <= width) return compact;

	// At very narrow widths, preserve parallel-root uniqueness with a short
	// one-based instance marker instead of dropping the friend suffix entirely.
	const instance = `×${persona.friendDepth + 1}`;
	const instanceWidth = visibleWidth(instance);
	if (width <= instanceWidth + 1) return truncateToWidth(instance, Math.max(0, width), "");
	return `${truncateToWidth(persona.base, width - instanceWidth - 1, "")} ${instance}`;
}
