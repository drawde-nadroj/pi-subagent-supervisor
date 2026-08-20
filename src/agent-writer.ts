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
	Partial<Pick<AgentConfig, "auto" | "fallback" | "returns" | "resultView">>;

export type AgentMutationAction = "toggle" | "edit" | "delete";

export function agentMutationRefusal(agent: Pick<AgentConfig, "source">, action: AgentMutationAction): string | undefined {
	if (agent.source === "project") {
		if (action === "toggle") return "Project agent definitions are read-only; auto-routing cannot be changed here.";
		if (action === "edit") return "Project agent definitions are read-only. Open the source file to edit it externally.";
		return "Project agent definitions are read-only and cannot be deleted here.";
	}
	if (agent.source === "bundled" && action === "delete") {
		return "Bundled roles cannot be deleted. Create a user override to customize one.";
	}
	return undefined;
}

export function serializeAgent(a: WritableAgent): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${yamlString(a.name)}`);
	if (a.displayName?.trim()) lines.push(`displayName: ${yamlString(a.displayName.trim())}`);
	lines.push(`description: ${yamlString(a.description)}`);
	if (a.auto === false) lines.push("auto: false");
	if (a.model) lines.push(`model: ${yamlString(a.model)}`);
	if (a.fallback && a.fallback.length > 0) lines.push(`fallback: [${a.fallback.map(yamlString).join(", ")}]`);
	if (a.thinking) lines.push(`thinking: ${yamlString(a.thinking)}`);
	if (a.tools !== undefined) lines.push(`tools: [${a.tools.map(yamlString).join(", ")}]`);
	if (a.readonly) lines.push("readonly: true");
	lines.push(`color: ${yamlString(a.color)}`);
	if (a.conventions) lines.push("conventions: true");
	if (a.returns) lines.push(`returns: ${JSON.stringify(a.returns)}`);
	if (a.returns && a.resultView) lines.push(`resultView: ${a.resultView}`);
	if (a.spawn && a.spawn.length > 0) lines.push(`spawn: [${a.spawn.map(yamlString).join(", ")}]`);
	lines.push("---", "", a.systemPrompt.trim(), "");
	return lines.join("\n");
}

// The configured user-agent directory and its ancestors are trusted. Persistence protects only the exact final file component.
function noFollowFlag(): number {
	const flag = fs.constants.O_NOFOLLOW;
	return typeof flag === "number" ? flag : 0;
}

function assertRegularDescriptor(fd: number, filePath: string): fs.Stats {
	const stat = fs.fstatSync(fd);
	if (!stat.isFile()) throw new Error(`Refusing non-regular agent file: ${filePath}`);
	return stat;
}

function openExistingRegularFile(filePath: string, flags: number): number {
	const before = fs.lstatSync(filePath);
	if (!before.isFile()) throw new Error(`Refusing non-regular agent file: ${filePath}`);
	const fd = fs.openSync(filePath, flags | noFollowFlag());
	try {
		const opened = assertRegularDescriptor(fd, filePath);
		if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`Agent file changed while opening: ${filePath}`);
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

function readRegularFile(filePath: string): string {
	const fd = openExistingRegularFile(filePath, fs.constants.O_RDONLY);
	try {
		return fs.readFileSync(fd, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

function createRegularFile(filePath: string, content: string): void {
	// O_EXCL refuses every existing final component, including a symlink, on all supported platforms.
	const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try {
		assertRegularDescriptor(fd, filePath);
		fs.writeFileSync(fd, content, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

function overwriteRegularFile(filePath: string, content: string): void {
	const fd = openExistingRegularFile(filePath, fs.constants.O_WRONLY);
	try {
		fs.ftruncateSync(fd, 0);
		fs.writeFileSync(fd, content, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

function userAgentDir(): string {
	return path.join(getAgentDir(), "agents");
}

function assertUserFilePath(filePath: string): void {
	if (path.resolve(path.dirname(filePath)) !== path.resolve(userAgentDir())) {
		throw new Error("Agent file is outside the user agent directory");
	}
}

function identityCollision(name: string): NodeJS.ErrnoException {
	const error = new Error(`A user definition already has the identity ${name}`) as NodeJS.ErrnoException;
	error.code = "EEXIST";
	return error;
}

function findUserIdentityPath(name: string, exceptPath?: string): string | undefined {
	const dir = userAgentDir();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
		const candidate = path.join(dir, entry.name);
		if (exceptPath && path.resolve(candidate) === path.resolve(exceptPath)) continue;
		if (existingAgentIdentity(candidate) === name) return candidate;
	}
	return undefined;
}

function assertUniqueUserIdentity(name: string, exceptPath?: string): void {
	if (findUserIdentityPath(name, exceptPath)) throw identityCollision(name);
}

function fileNameForAgent(name: string): string {
	const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	return `${safe}.md`;
}

export function writeAgentFile(a: WritableAgent, dir: string): string {
	if (path.resolve(dir) !== path.resolve(userAgentDir())) throw new Error("Agents can only be written to the user agent directory");
	fs.mkdirSync(dir, { recursive: true });
	assertUniqueUserIdentity(a.name);
	const file = path.join(dir, fileNameForAgent(a.name));
	createRegularFile(file, serializeAgent(a));
	clearDiscoverCache();
	return file;
}

export function updateAgentFile(agent: WritableAgent & Pick<AgentConfig, "source" | "filePath">): void {
	if (agent.source !== "user") throw new Error("Only user agent definitions can be written");
	assertUserFilePath(agent.filePath);
	overwriteRegularFile(agent.filePath, serializeAgent(agent));
	clearDiscoverCache();
}

export function renameUserAgentFile(agent: WritableAgent & Pick<AgentConfig, "source" | "filePath">): string {
	if (agent.source !== "user") throw new Error("Only user agent definitions can be renamed");
	assertUserFilePath(agent.filePath);
	assertUniqueUserIdentity(agent.name, agent.filePath);
	const destination = path.join(userAgentDir(), fileNameForAgent(agent.name));
	if (path.resolve(destination) === path.resolve(agent.filePath)) {
		overwriteRegularFile(agent.filePath, serializeAgent(agent));
		clearDiscoverCache();
		return destination;
	}
	createRegularFile(destination, serializeAgent(agent));
	try {
		deleteAgentFile(agent);
	} catch (error) {
		try {
			fs.unlinkSync(destination);
		} catch {
			/* preserve the original failure */
		}
		throw error;
	}
	clearDiscoverCache();
	return destination;
}

function existingAgentIdentity(filePath: string): string | undefined {
	return parseAgentFile(readRegularFile(filePath), filePath, "user")?.name;
}

/** Return a writable user copy for package-managed bundled definitions. */
export function materializeUserOverride(agent: AgentConfig): AgentConfig {
	if (agent.source !== "bundled") return agent;
	const dir = userAgentDir();
	fs.mkdirSync(dir, { recursive: true });
	const safe = path.basename(fileNameForAgent(agent.name), ".md");
	const standardPath = path.join(dir, fileNameForAgent(agent.name));
	if (findUserIdentityPath(agent.name, standardPath)) throw identityCollision(agent.name);
	const serialized = serializeAgent(agent);
	let filePath = standardPath;

	try {
		createRegularFile(standardPath, serialized);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (existingAgentIdentity(standardPath) === agent.name) {
			overwriteRegularFile(standardPath, serialized);
		} else {
			for (let n = 1; ; n++) {
				filePath = path.join(dir, `${safe}-override${n === 1 ? "" : `-${n}`}.md`);
				try {
					createRegularFile(filePath, serialized);
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

export function deleteAgentFile(agent: Pick<AgentConfig, "source" | "filePath">): void {
	if (agent.source !== "user") throw new Error("Only user agent definitions can be deleted");
	assertUserFilePath(agent.filePath);
	try {
		if (!fs.lstatSync(agent.filePath).isFile()) throw new Error(`Refusing non-regular agent file: ${agent.filePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	// If the final component changes after lstat, unlink still removes that component rather than following it.
	fs.unlinkSync(agent.filePath);
	clearDiscoverCache();
}
