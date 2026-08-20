import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");

export const READONLY_TOOLS = ["read", "grep", "find", "ls"];
const EXPLICIT_READONLY_TOOLS = [...READONLY_TOOLS, "git-inspect"];

/** Claude tool names → pi tool names (for optional .claude/agents discovery). */
const CLAUDE_TOOL_MAP: Record<string, string> = {
	Read: "read",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	Bash: "bash",
	Edit: "edit",
	Write: "write",
	MultiEdit: "edit",
};

export interface AgentConfig {
	/** Durable routing, command, and persistence identity. */
	name: string;
	/** Optional human-facing persona name. Never used for routing or persistence. */
	displayName?: string;
	description: string;
	model?: string;
	/** Backup model patterns tried in order when a run fails with a provider-shaped
	 * error (quota/auth/network/5xx) — never on ordinary task failures. */
	fallback: string[];
	/** Advertised to the main model for proactive routing. false = hidden, but still
	 * reachable via /name, dashboard sequences, or an explicit user-named request. */
	auto: boolean;
	/** Optional JSON-schema subset the child's reply must end with (see returns.ts).
	 * Gated by the structured-returns setting; validated with one repair turn. */
	returns?: import("./returns.ts").ReturnsSchema;
	/** Optional TUI presentation override for valid structured returns. */
	resultView?: import("./result-view.ts").ResultView;
	thinking?: string;
	tools?: string[];
	readonly: boolean;
	color: string;
	/** Inherit global and path-scoped AGENTS.md conventions (and no other context files). */
	conventions: boolean;
	spawn: string[];
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface RawFrontmatter {
	[key: string]: unknown;
	name?: string;
	displayName?: string;
	description?: string;
	model?: string;
	fallback?: string[] | string;
	/** Alias accepted for compatibility with nicobailon/pi-subagents agent files. */
	fallbackModels?: string[] | string;
	auto?: unknown;
	returns?: unknown;
	resultView?: unknown;
	/** Legacy routing field: always/judgment → auto, never → manual. */
	advertise?: unknown;
	thinking?: string;
	tools?: string[] | string;
	readonly?: boolean | string;
	color?: string;
	conventions?: boolean | string;
	/** Legacy alias for `conventions`. */
	fork?: boolean | string;
	spawn?: string[] | string;
}

function asBool(v: boolean | string | undefined): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v.trim().toLowerCase() === "true";
	return false;
}

function asList(v: string[] | string | undefined): string[] {
	if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
	if (typeof v === "string")
		return v
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	return [];
}

const FALLBACK_COLORS = ["cyan", "purple", "green", "orange", "blue", "pink", "yellow", "magenta"];

function asAuto(auto: unknown, legacyAdvertise: unknown): boolean {
	if (typeof auto === "boolean") return auto;
	if (typeof auto === "string") {
		const normalized = auto.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	if (auto !== undefined) return false;
	if (legacyAdvertise === undefined) return true;
	if (typeof legacyAdvertise !== "string") return false;
	const legacy = legacyAdvertise.trim().toLowerCase();
	if (legacy === "never") return false;
	return legacy === "always" || legacy === "judgment";
}

export function parseAgentFile(
	content: string,
	filePath: string,
	source: "bundled" | "user" | "project",
	translateClaudeTools = false,
): AgentConfig | null {
	const { frontmatter, body } = parseFrontmatter<RawFrontmatter>(content);
	if (!frontmatter.name || !frontmatter.description) return null;

	let tools = asList(frontmatter.tools);
	if (translateClaudeTools) tools = tools.map((t) => CLAUDE_TOOL_MAP[t] ?? t.toLowerCase());

	const nameHash = [...frontmatter.name].reduce((a, c) => a + c.charCodeAt(0), 0);

	return {
		name: frontmatter.name.trim(),
		displayName: frontmatter.displayName?.trim() || undefined,
		description: frontmatter.description.trim(),
		model: frontmatter.model?.trim() || undefined,
		fallback: asList(frontmatter.fallback ?? frontmatter.fallbackModels),
		auto: asAuto(frontmatter.auto, frontmatter.advertise),
		returns: frontmatter.returns && typeof frontmatter.returns === "object" && !Array.isArray(frontmatter.returns) ? (frontmatter.returns as import("./returns.ts").ReturnsSchema) : undefined,
		resultView: frontmatter.returns && typeof frontmatter.returns === "object" && !Array.isArray(frontmatter.returns) && (frontmatter.resultView === "readable" || frontmatter.resultView === "exact") ? frontmatter.resultView : undefined,
		thinking: frontmatter.thinking?.trim() || undefined,
		tools: Object.hasOwn(frontmatter, "tools") ? tools : undefined,
		readonly: asBool(frontmatter.readonly),
		color: frontmatter.color?.trim() || FALLBACK_COLORS[nameHash % FALLBACK_COLORS.length],
		conventions: asBool(frontmatter.conventions ?? frontmatter.fork),
		spawn: asList(frontmatter.spawn),
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

/** Human-facing name with the durable role as the backwards-compatible fallback. */
export function agentDisplayName(agent: Pick<AgentConfig, "name" | "displayName">): string {
	return agent.displayName?.trim() || agent.name;
}

/** Build the tool config for a child session from an agent's allowlist / readonly shorthand.
 * When `includeSubagent` is set (the agent may delegate), the scoped `subagent` tool is
 * added to any explicit allowlist so the injected custom tool is actually enabled. */
export function resolveChildToolNames(agent: AgentConfig, includeSubagent = false): { tools?: string[]; noTools?: "all" | "builtin" } {
	const withSubagent = (tools: string[]): string[] => (includeSubagent && !tools.includes("subagent") ? [...tools, "subagent"] : tools);
	if (agent.readonly) {
		const base = agent.tools === undefined ? READONLY_TOOLS : agent.tools.filter((t) => EXPLICIT_READONLY_TOOLS.includes(t));
		return { tools: withSubagent(base) };
	}
	if (agent.tools !== undefined) return { tools: withSubagent(agent.tools) };
	return {}; // inherit pi defaults (read, bash, edit, write) + custom tools are enabled by default
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function readRegularFile(filePath: string): string | null {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const opened = fs.fstatSync(fd);
		const current = fs.lstatSync(filePath);
		if (!opened.isFile() || !current.isFile() || !sameFile(opened, current)) return null;
		return fs.readFileSync(fd, "utf-8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function loadDir(dir: string, source: "bundled" | "user" | "project", translateClaudeTools = false): AgentConfig[] {
	let entries: fs.Dirent[];
	let directory: fs.Stats;
	try {
		directory = fs.lstatSync(dir);
		if (!directory.isDirectory()) return [];
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: AgentConfig[] = [];
	for (const e of entries) {
		if (!e.name.endsWith(".md") || !e.isFile()) continue;
		const fp = path.join(dir, e.name);
		try {
			if (!sameFile(directory, fs.lstatSync(dir))) return [];
			const contents = readRegularFile(fp);
			if (contents === null) continue;
			if (!sameFile(directory, fs.lstatSync(dir))) return [];
			const cfg = parseAgentFile(contents, fp, source, translateClaudeTools);
			// Compatibility for copies of the formerly misnamed bundled definition.
			// Keep this exact to the user-layer filename and legacy frontmatter value.
			if (cfg && source === "user" && e.name === "test-writer.md" && cfg.name === "test writer") cfg.name = "test-writer";
			if (cfg) out.push(cfg);
		} catch {
			/* skip unreadable */
		}
	}
	return out;
}

function findProjectDir(cwd: string, ...segments: string[]): string | null {
	let cur = cwd;
	while (true) {
		const candidate = path.join(cur, ...segments);
		try {
			let component = cur;
			let valid = true;
			for (const segment of segments) {
				component = path.join(component, segment);
				if (fs.lstatSync(component).isSymbolicLink()) {
					valid = false;
					break;
				}
			}
			if (valid && fs.lstatSync(candidate).isDirectory()) return candidate;
		} catch {
			/* ignore */
		}
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/** A cheap fingerprint of a directory's agent files: each `.md`'s name, mtime, and
 * size. Changes the instant any file is added, removed, or edited — so a signature
 * match means "nothing on disk changed" and the previous parse is still valid. Much
 * cheaper than the readFile + parseFrontmatter it lets us skip. */
function dirFileSignature(dir: string | null): string {
	if (!dir) return "";
	let entries: fs.Dirent[];
	try {
		if (!fs.lstatSync(dir).isDirectory()) return "";
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return "";
	}
	const parts: string[] = [];
	for (const e of entries) {
		if (!e.name.endsWith(".md") || !e.isFile()) continue;
		try {
			const st = fs.lstatSync(path.join(dir, e.name));
			if (st.isFile()) parts.push(`${e.name}:${st.mtimeMs}:${st.size}`);
		} catch {
			/* skip unreadable */
		}
	}
	parts.sort();
	return parts.join("|");
}

interface DiscoverCacheEntry {
	signature: string;
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}
/** Keyed by `${cwd}\0${includeProject}`. discoverAgents is called on every turn,
 * every interactive keystroke-submit, and every failed bash
 * attempt; without this each of those re-read and re-parsed the whole roster. The
 * mtime signature keeps edits instant while making repeat calls essentially free. */
const discoverCache = new Map<string, DiscoverCacheEntry>();

/** Test/hot-reload hook: drop the discovery cache so the next call re-reads disk. */
export function clearDiscoverCache(): void {
	discoverCache.clear();
}

export function discoverAgents(cwd: string, opts: { includeProject: boolean }): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = opts.includeProject ? findProjectDir(cwd, CONFIG_DIR_NAME, "agents") : null;
	const claudeAgentsDir = opts.includeProject ? findProjectDir(cwd, ".claude", "agents") : null;

	// Signature over exactly the dirs we will read, in read order. A change to any of
	// them (or a project dir appearing/disappearing) invalidates the cache.
	const signature = [BUNDLED_AGENTS_DIR, userDir, claudeAgentsDir, projectAgentsDir].map((d) => `${d ?? ""}#${dirFileSignature(d)}`).join("\n");
	const key = `${cwd}\0${opts.includeProject}`;
	const cached = discoverCache.get(key);
	// Return a fresh array (shared, read-only AgentConfig objects) so a caller that
	// sorts in place — e.g. the dashboard — never mutates the cached roster.
	if (cached && cached.signature === signature) return { agents: [...cached.agents], projectAgentsDir: cached.projectAgentsDir };

	const map = new Map<string, AgentConfig>();
	for (const a of loadDir(BUNDLED_AGENTS_DIR, "bundled")) map.set(a.name, a);
	for (const a of loadDir(userDir, "user")) map.set(a.name, a);
	if (opts.includeProject) {
		// .claude/agents first, then native project agents (native wins on conflict).
		if (claudeAgentsDir) for (const a of loadDir(claudeAgentsDir, "project", true)) map.set(a.name, a);
		if (projectAgentsDir) for (const a of loadDir(projectAgentsDir, "project")) map.set(a.name, a);
	}
	const agents = [...map.values()];
	discoverCache.set(key, { signature, agents, projectAgentsDir });
	return { agents: [...agents], projectAgentsDir };
}
