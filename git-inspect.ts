import { spawnSync } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfig } from "./agents.ts";

const SECTION_CAP_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 15_000;

function truncateUtf8(text: string, cap = SECTION_CAP_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	let end = Math.min(text.length, cap);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > cap) end--;
	return `${text.slice(0, end)}\n[truncated at ${Math.floor(cap / 1024)}KB]`;
}

function runGit(cwd: string, args: readonly string[], input?: string): { output: string; ok: boolean } {
	const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
		cwd,
		encoding: "utf8",
		input,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: SECTION_CAP_BYTES * 8,
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
			GIT_EXTERNAL_DIFF: "",
			GIT_OPTIONAL_LOCKS: "0",
		},
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
	if (result.error) {
		if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS" && output) return { output: truncateUtf8(output), ok: true };
		return { output: `git ${args[0]} failed: ${result.error.message}`, ok: false };
	}
	return { output: output || "(none)", ok: result.status === 0 };
}

function git(cwd: string, args: readonly string[]): string {
	return runGit(cwd, args).output;
}

interface SecurityGitResult {
	stdout: Buffer;
	status: number | null;
	error?: Error;
}

/** Security checks require complete byte-for-byte metadata. Unlike display
 * commands, overflow is an error and NUL-delimited filenames stay as buffers. */
function runSecurityGit(cwd: string, args: readonly string[], input?: Buffer, maxBuffer = 32 * 1024 * 1024): SecurityGitResult {
	const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
		cwd,
		input,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer,
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
			GIT_OPTIONAL_LOCKS: "0",
		},
	});
	return {
		stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
		status: result.status,
		error: result.error,
	};
}

function complete(result: SecurityGitResult, allowedStatuses: number[] = [0]): boolean {
	return !result.error && result.status !== null && allowedStatuses.includes(result.status);
}

function decodeMetadata(value: Buffer): string | undefined {
	const text = value.toString("utf8");
	return text.includes("\uFFFD") ? undefined : text;
}

/** Detect repository-effective clean/process filters before any status or diff command.
 * `config`, `ls-files`, and `check-attr` inspect metadata only and never feed file
 * contents to the configured programs. A failed, oversized, or undecodable check
 * fails closed. */
function activeExternalFilters(cwd: string, maxBuffer?: number): string[] {
	const unsafe = "(unable to inspect repository filters safely)";
	const configured = runSecurityGit(cwd, ["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"], undefined, maxBuffer);
	if (!complete(configured, [0, 1])) return [unsafe];
	const names = new Set<string>();
	for (const record of configured.stdout.toString("binary").split("\0")) {
		if (!record) continue;
		const separator = record.indexOf("\n");
		if (separator < 0) return [unsafe];
		const keyBytes = Buffer.from(record.slice(0, separator), "binary");
		const key = decodeMetadata(keyBytes);
		if (key === undefined) return [unsafe];
		const match = /^filter\.(.*)\.(?:clean|process)$/i.exec(key);
		if (match) names.add(match[1]);
	}
	if (names.size === 0) return [];

	const files = runSecurityGit(cwd, ["ls-files", "-co", "--exclude-standard", "-z"], undefined, maxBuffer);
	if (!complete(files)) return [unsafe];
	if (files.stdout.length === 0) return [];
	const attrs = runSecurityGit(cwd, ["check-attr", "--stdin", "-z", "filter"], files.stdout, maxBuffer);
	if (!complete(attrs)) return [unsafe];
	const fields = attrs.stdout.toString("binary").split("\0");
	const active = new Set<string>();
	for (let i = 0; i + 2 < fields.length; i += 3) {
		const value = decodeMetadata(Buffer.from(fields[i + 2], "binary"));
		if (value === undefined) return [unsafe];
		if (names.has(value)) active.add(value);
	}
	return [...active].sort();
}

/** A fixed, mechanically read-only repository view. It accepts no commands or paths. */
export function inspectGitRepository(cwd: string, securityMaxBufferBytes?: number): string {
	const filters = activeExternalFilters(cwd, securityMaxBufferBytes);
	if (filters.length > 0) {
		if (filters[0].startsWith("(")) return `Git inspection refused: ${filters[0].slice(1, -1)}. No status or diff command was run.`;
		return `Git inspection refused: active repository-configured external clean/process filters were detected (${filters.join(", ")}). No status or diff command was run.`;
	}
	const sections = [
		["Status", git(cwd, ["status", "--short", "--branch", "--untracked-files=all"])],
		["Staged diff", git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--"])],
		["Unstaged diff", git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"])],
	];
	return sections.map(([title, body]) => `## ${title}\n${truncateUtf8(body)}`).join("\n\n");
}

export function createGitInspectTool(cwd: string): ToolDefinition {
	return {
		name: "git-inspect",
		label: "Git inspect",
		description: "Read repository status plus staged and unstaged diffs. Accepts no command or path and never uses a shell.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: inspectGitRepository(cwd) }], details: undefined };
		},
	};
}

export function gitInspectToolForAgent(agent: Pick<AgentConfig, "tools">, cwd: string): ToolDefinition | undefined {
	return agent.tools?.includes("git-inspect") ? createGitInspectTool(cwd) : undefined;
}
