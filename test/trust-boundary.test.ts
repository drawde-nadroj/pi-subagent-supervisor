import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { agentMutationRefusal, deleteAgentFile, materializeUserOverride, renameUserAgentFile, updateAgentFile, writeAgentFile } from "../src/agent-writer.ts";
import { clearDiscoverCache, discoverAgents, type AgentConfig } from "../src/agents.ts";

function definition(name: string, description = name): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nPrompt\n`;
}

function writeDefinition(dir: string, name: string, description = name): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.md`);
	fs.writeFileSync(file, definition(name, description));
	return file;
}

function withSandbox(run: (root: string, project: string, userAgents: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-trust-"));
	const project = path.join(root, "project", "nested");
	const userAgents = path.join(root, "home", "agents");
	fs.mkdirSync(project, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home");
	clearDiscoverCache();
	try {
		run(root, project, userAgents);
	} finally {
		clearDiscoverCache();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const writable = (name: string): Parameters<typeof writeAgentFile>[0] => ({
	name,
	description: `${name} description`,
	color: "blue",
	systemPrompt: `${name} prompt`,
});

test("dashboard mutation policy preserves bundled and user writes while refusing project writes", () => {
	for (const action of ["toggle", "edit", "delete"] as const) {
		assert.match(agentMutationRefusal({ source: "project" }, action) ?? "", /read-only/);
	}
	assert.equal(agentMutationRefusal({ source: "bundled" }, "toggle"), undefined);
	assert.equal(agentMutationRefusal({ source: "bundled" }, "edit"), undefined);
	assert.match(agentMutationRefusal({ source: "bundled" }, "delete") ?? "", /cannot be deleted/);
	assert.equal(agentMutationRefusal({ source: "user" }, "toggle"), undefined);
	assert.equal(agentMutationRefusal({ source: "user" }, "edit"), undefined);
	assert.equal(agentMutationRefusal({ source: "user" }, "delete"), undefined);
});

test("discovery loads regular files but ignores an outside-target file symlink without invalidating the cache", () => {
	withSandbox((root, project, userAgents) => {
		writeDefinition(userAgents, "regular", "regular file");
		let result = discoverAgents(project, { includeProject: false });
		assert.equal(result.agents.find((agent) => agent.name === "regular")?.description, "regular file");

		const outside = writeDefinition(path.join(root, "outside"), "outside-target", "must stay outside");
		fs.symlinkSync(outside, path.join(userAgents, "outside-link.md"));
		result = discoverAgents(project, { includeProject: false });
		assert.equal(result.agents.some((agent) => agent.name === "outside-target"), false, "a file symlink to an outside target is ignored");
	});
});

test("discovery ignores an inside-directory file symlink while loading its direct regular target once", () => {
	withSandbox((_root, project, userAgents) => {
		const insideTarget = writeDefinition(userAgents, "inside-target", "direct regular file");
		discoverAgents(project, { includeProject: false });
		fs.symlinkSync(insideTarget, path.join(userAgents, "zzz-inside-link.md"));
		const result = discoverAgents(project, { includeProject: false });
		const matches = result.agents.filter((agent) => agent.name === "inside-target");
		assert.equal(matches.length, 1);
		assert.equal(matches[0].filePath, insideTarget, "the symlink entry cannot replace the direct regular definition");
	});
});

test("discovery ignores a symlinked user agent directory", () => {
	withSandbox((root, project, userAgents) => {
		const outsideAgents = path.join(root, "outside-agents");
		writeDefinition(outsideAgents, "linked-user", "must not load");
		fs.mkdirSync(path.dirname(userAgents), { recursive: true });
		fs.symlinkSync(outsideAgents, userAgents, "dir");
		const result = discoverAgents(project, { includeProject: false });
		assert.equal(result.agents.some((agent) => agent.name === "linked-user"), false);
	});
});

test("project discovery rejects a symlinked .pi component", () => {
	withSandbox((root, project, _userAgents) => {
		const outsidePi = path.join(root, "outside-pi");
		writeDefinition(path.join(outsidePi, "agents"), "pi-linked", "must not load");
		fs.symlinkSync(outsidePi, path.join(root, "project", ".pi"), "dir");
		const result = discoverAgents(project, { includeProject: true });
		assert.equal(result.agents.some((agent) => agent.name === "pi-linked"), false);
	});
});

test("project discovery rejects a symlinked .claude/agents component", () => {
	withSandbox((root, project, _userAgents) => {
		const claudeRoot = path.join(root, "project", ".claude");
		const outsideClaudeAgents = path.join(root, "outside-claude-agents");
		writeDefinition(outsideClaudeAgents, "claude-linked", "must not load");
		fs.mkdirSync(claudeRoot);
		fs.symlinkSync(outsideClaudeAgents, path.join(claudeRoot, "agents"), "dir");
		const result = discoverAgents(project, { includeProject: true });
		assert.equal(result.agents.some((agent) => agent.name === "claude-linked"), false);
	});
});

test("regular project files preserve native-over-user precedence", () => {
	withSandbox((root, project, userAgents) => {
		writeDefinition(userAgents, "priority", "user");
		writeDefinition(path.join(root, "project", ".pi", "agents"), "priority", "native");
		const result = discoverAgents(project, { includeProject: true });
		assert.equal(result.agents.find((agent) => agent.name === "priority")?.description, "native");
	});
});

test("writeAgentFile creates exclusively and fails closed on an existing file or symlink", () => {
	withSandbox((root, _project, userAgents) => {
		const regularPath = writeAgentFile(writable("regular-writer"), userAgents);
		const originalDefinition = fs.readFileSync(regularPath, "utf8");
		assert.throws(() => writeAgentFile({ ...writable("regular-writer"), description: "must not overwrite" }, userAgents), { code: "EEXIST" });
		assert.equal(fs.readFileSync(regularPath, "utf8"), originalDefinition);

		const target = path.join(root, "writer-target.md");
		const original = "outside writer target\n";
		fs.writeFileSync(target, original);
		fs.symlinkSync(target, path.join(userAgents, "linked-writer.md"));
		assert.throws(() => writeAgentFile(writable("linked-writer"), userAgents), { code: "EEXIST" });
		assert.equal(fs.readFileSync(target, "utf8"), original, "the symlink target is not modified");
	});
});

test("updateAgentFile overwrites user files but rejects symlink and project paths", () => {
	withSandbox((root, _project, userAgents) => {
		const filePath = writeAgentFile(writable("editable"), userAgents);
		updateAgentFile({ ...writable("editable"), description: "updated", source: "user", filePath });
		assert.match(fs.readFileSync(filePath, "utf8"), /description: updated/);

		const target = path.join(root, "outside-update-target.md");
		const original = definition("outside", "outside original");
		fs.writeFileSync(target, original);
		const linked = path.join(userAgents, "linked-update.md");
		fs.symlinkSync(target, linked);
		assert.throws(() => updateAgentFile({ ...writable("linked"), source: "user", filePath: linked }));
		assert.equal(fs.readFileSync(target, "utf8"), original);
		assert.throws(() => updateAgentFile({ ...writable("project"), source: "project", filePath }));
		assert.throws(() => updateAgentFile({ ...writable("outside"), source: "user", filePath: target }), /outside the user agent directory/);
		assert.equal(fs.readFileSync(target, "utf8"), original);
	});
});

test("renameUserAgentFile refuses occupied slugs without damaging either definition", () => {
	withSandbox((_root, _project, userAgents) => {
		const sourcePath = writeAgentFile(writable("source"), userAgents);
		const occupiedPath = writeAgentFile(writable("occupied-name"), userAgents);
		const sourceBytes = fs.readFileSync(sourcePath);
		const occupiedBytes = fs.readFileSync(occupiedPath);

		assert.throws(
			() => renameUserAgentFile({ ...writable("occupied name"), source: "user", filePath: sourcePath }),
			{ code: "EEXIST" },
		);
		assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);
		assert.deepEqual(fs.readFileSync(occupiedPath), occupiedBytes);

		const secondSourcePath = writeAgentFile(writable("second-source"), userAgents);
		const noncanonicalPath = path.join(userAgents, "legacy-file.md");
		fs.writeFileSync(noncanonicalPath, definition("existing identity", "noncanonical existing definition"));
		const secondSourceBytes = fs.readFileSync(secondSourcePath);
		const noncanonicalBytes = fs.readFileSync(noncanonicalPath);
		assert.throws(
			() => renameUserAgentFile({ ...writable("existing identity"), source: "user", filePath: secondSourcePath }),
			{ code: "EEXIST" },
		);
		assert.deepEqual(fs.readFileSync(secondSourcePath), secondSourceBytes);
		assert.deepEqual(fs.readFileSync(noncanonicalPath), noncanonicalBytes);

		const sameSlugPath = writeAgentFile(writable("same-slug"), userAgents);
		const renamedPath = renameUserAgentFile({ ...writable("same slug"), description: "same path update", source: "user", filePath: sameSlugPath });
		assert.equal(renamedPath, sameSlugPath);
		assert.match(fs.readFileSync(sameSlugPath, "utf8"), /name: same slug/);
	});
});

test("materializeUserOverride fails closed when its overwrite path is a symlink", () => {
	withSandbox((root, _project, userAgents) => {
		const bundled = discoverAgents(path.join(root, "project"), { includeProject: false }).agents.find(
			(agent) => agent.name === "worker" && agent.source === "bundled",
		) as AgentConfig;
		assert.ok(bundled);
		fs.mkdirSync(userAgents, { recursive: true });
		const target = path.join(root, "override-target.md");
		const original = definition("worker", "outside original");
		fs.writeFileSync(target, original);
		fs.symlinkSync(target, path.join(userAgents, "worker.md"));
		assert.throws(() => materializeUserOverride(bundled));
		assert.equal(fs.readFileSync(target, "utf8"), original, "the override symlink target is not modified");
	});
});

test("materializeUserOverride refuses a noncanonical duplicate identity", () => {
	withSandbox((root, _project, userAgents) => {
		const bundled = discoverAgents(path.join(root, "project"), { includeProject: false }).agents.find(
			(agent) => agent.name === "worker" && agent.source === "bundled",
		) as AgentConfig;
		assert.ok(bundled);
		fs.mkdirSync(userAgents, { recursive: true });
		const canonicalPath = path.join(userAgents, "worker.md");
		const noncanonicalPath = path.join(userAgents, "legacy-worker-name.md");
		const canonical = definition("worker", "canonical user customization");
		const noncanonical = definition("worker", "noncanonical user customization");
		fs.writeFileSync(canonicalPath, canonical);
		fs.writeFileSync(noncanonicalPath, noncanonical);

		assert.throws(() => materializeUserOverride(bundled), { code: "EEXIST" });
		assert.equal(fs.readFileSync(canonicalPath, "utf8"), canonical);
		assert.equal(fs.readFileSync(noncanonicalPath, "utf8"), noncanonical);
	});
});

test("deleteAgentFile rejects a final-component symlink", () => {
	withSandbox((root, _project, userAgents) => {
		fs.mkdirSync(userAgents, { recursive: true });
		const outsideFile = path.join(root, "outside-delete-target.md");
		fs.writeFileSync(outsideFile, "outside file\n");
		const linkedFile = path.join(userAgents, "linked-delete.md");
		fs.symlinkSync(outsideFile, linkedFile);
		assert.throws(() => deleteAgentFile({ source: "user", filePath: linkedFile }));
		assert.throws(() => deleteAgentFile({ source: "project", filePath: linkedFile }), /Only user/);
		assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside file\n");
	});
});
