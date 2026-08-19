import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

type TextPart = { type: "text"; text: string };
type ToolResultContent = ToolResultEvent["content"];

const TEST_BUILD_RE = /(?:^|[\s;&|])(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)\b|(?:^|[\s;&|])(?:vitest|jest|mocha|playwright|tsc)\b/;

export function isTestOrBuildCommand(command: unknown): boolean {
	return typeof command === "string" && TEST_BUILD_RE.test(command);
}

export function appendDebuggerNudge(content: ToolResultContent, command: string): ToolResultContent {
	const nudge = `\n\nSubagents nudge: \`${command}\` failed. Treat this as a known failure event and consider routing root-cause work through the debugger subagent.`;
	const out = [...content];
	for (let i = out.length - 1; i >= 0; i--) {
		const part = out[i];
		if (part.type === "text" && typeof part.text === "string") {
			out[i] = { ...part, text: `${part.text}${nudge}` };
			return out;
		}
	}
	out.push({ type: "text", text: nudge.trimStart() });
	return out;
}
