import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, clearDiscoverCache, parseAgentFile } from "./agents.ts";

function yamlString(v: string): string {
	// Quote if it contains characters that would break a bare YAML scalar.
	if (v === "" || /[:#\[\]{}",&*!|>%@`]/.test(v) || /^\s|\s$/.test(v) || /^[-?]/.test(v)) {
		return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return v;
}

export type WritableAgent = Pick<
	AgentConfig,
	"name" | "displayName" | "description" | "model" | "thinking" | "tools" | "readonly" | "color" | "conventions" | "spawn" | "systemPrompt"
> &
	Partial<Pick<AgentConfig, "auto" | "fallback" | "returns">>;

export function serializeAgent(a: WritableAgent): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${yamlString(a.name)}`);
	if (a.displayName?.trim()) lines.push(`displayName: ${yamlString(a.displayName.trim())}`);
	lines.push(`description: ${yamlString(a.description)}`);
	if (a.auto === false) lines.push("auto: false");
	if (a.model) lines.push(`model: ${yamlString(a.model)}`);
	if (a.fallback && a.fallback.length > 0) lines.push(`fallback: [${a.fallback.map(yamlString).join(", ")}]`);
	if (a.thinking) lines.push(`thinking: ${yamlString(a.thinking)}`);
	if (a.tools && a.tools.length > 0) lines.push(`tools: [${a.tools.map(yamlString).join(", ")}]`);
	if (a.readonly) lines.push("readonly: true");
	lines.push(`color: ${yamlString(a.color)}`);
	if (a.conventions) lines.push("conventions: true");
	if (a.returns) lines.push(`returns: ${JSON.stringify(a.returns)}`);
	if (a.spawn && a.spawn.length > 0) lines.push(`spawn: [${a.spawn.map(yamlString).join(", ")}]`);
	lines.push("---", "", a.systemPrompt.trim(), "");
	return lines.join("\n");
}

export function writeAgentFile(a: WritableAgent, dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const safe = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	const file = path.join(dir, `${safe}.md`);
	fs.writeFileSync(file, serializeAgent(a), "utf-8");
	// The roster on disk just changed — drop the discovery cache so the next read is fresh
	// even if the filesystem's mtime resolution is too coarse to notice this write.
	clearDiscoverCache();
	return file;
}

function existingAgentIdentity(filePath: string): string | undefined {
	try {
		return parseAgentFile(fs.readFileSync(filePath, "utf-8"), filePath, "user")?.name;
	} catch {
		return undefined;
	}
}

/** Return a writable user copy for package-managed bundled definitions. */
export function materializeUserOverride(agent: AgentConfig): AgentConfig {
	if (agent.source !== "bundled") return agent;
	const dir = path.join(getAgentDir(), "agents");
	fs.mkdirSync(dir, { recursive: true });
	const safe = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	const standardPath = path.join(dir, `${safe}.md`);
	const serialized = serializeAgent(agent);
	let filePath = standardPath;

	try {
		fs.writeFileSync(standardPath, serialized, { encoding: "utf-8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (existingAgentIdentity(standardPath) === agent.name) {
			fs.writeFileSync(standardPath, serialized, "utf-8");
		} else {
			for (let n = 1; ; n++) {
				filePath = path.join(dir, `${safe}-override${n === 1 ? "" : `-${n}`}.md`);
				try {
					fs.writeFileSync(filePath, serialized, { encoding: "utf-8", flag: "wx" });
					break;
				} catch (candidateError) {
					if ((candidateError as NodeJS.ErrnoException).code !== "EEXIST") throw candidateError;
				}
			}
		}
	}
	clearDiscoverCache();
	return { ...agent, source: "user", filePath };
}

export function deleteAgentFile(filePath: string): void {
	if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
	clearDiscoverCache();
}
