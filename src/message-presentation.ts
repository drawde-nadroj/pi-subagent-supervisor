import type { RunResult } from "./engine.ts";
import { formatLiteralPersona, type PersonaDescriptor } from "./persona.ts";
import type { CallSnapshot, RunNodeSnapshot } from "./registry.ts";

/** Serializable identity fields shared by current and legacy custom messages. */
export interface StoredMessageIdentity {
	/** Legacy messages stored their durable role under `agent`. */
	agent?: string;
	role?: string;
	persona?: PersonaDescriptor;
}

/**
 * Resolve presentation only from fields stored with the message. Historical
 * transcript entries must never change when the current roster is renamed.
 */
export function presentMessageIdentity(identity: StoredMessageIdentity): {
	persona: string;
	role?: string;
} {
	const storedRole = identity.role ?? identity.agent ?? "subagent";
	const persona = identity.persona
		? formatLiteralPersona(identity.persona)
		: storedRole;
	return {
		persona,
		role: persona === storedRole ? undefined : storedRole,
	};
}

export interface TerminalOutputSummary {
	ok: boolean;
	text: string;
	elapsedMs?: number;
	usage: { input: number; output: number; cost: number; tools: number };
}

/**
 * Preserve the terminal answer from the requested run while taking presentation
 * metrics from the authoritative call graph. A nested child is real work, so a
 * terminal transcript summary must account for it just as the footer does.
 */
export function terminalOutputSummary(result: RunResult, snapshot?: CallSnapshot): TerminalOutputSummary {
	const text = result.ok ? result.finalText : result.error ?? result.finalText;
	if (!snapshot) {
		return {
			ok: result.ok,
			text,
			usage: {
				input: result.usage.input,
				output: result.usage.output,
				cost: result.usage.cost,
				tools: result.usage.toolCalls,
			},
		};
	}

	const usage = { input: 0, output: 0, tools: 0 };
	const visit = (node: RunNodeSnapshot): void => {
		usage.input += node.usage.input;
		usage.output += node.usage.output;
		usage.tools += node.usage.toolCalls;
		node.children.forEach(visit);
	};
	snapshot.roots.forEach(visit);
	return {
		ok: result.ok,
		text,
		elapsedMs: snapshot.durationMs,
		usage: { ...usage, cost: snapshot.totalCost },
	};
}
