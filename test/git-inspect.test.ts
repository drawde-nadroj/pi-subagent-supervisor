import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitInspectToolForAgent, inspectGitRepository } from "../src/git-inspect.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-inspect-"));
try {
	const run = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	};
	run("init", "-q");
	run("config", "user.name", "Test");
	run("config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
	run("add", "tracked.txt");
	run("commit", "-qm", "base");
	fs.writeFileSync(path.join(cwd, "tracked.txt"), "staged\n");
	run("add", "tracked.txt");
	fs.appendFileSync(path.join(cwd, "tracked.txt"), "unstaged\n");

	const output = inspectGitRepository(cwd);
	assert.match(output, /## Status[\s\S]*MM tracked\.txt/);
	assert.match(output, /## Staged diff[\s\S]*-base[\s\S]*\+staged/);
	assert.match(output, /## Unstaged diff[\s\S]*\+unstaged/);

	const reviewerTool = gitInspectToolForAgent({ tools: ["read", "git-inspect"] }, cwd);
	assert.equal(reviewerTool?.name, "git-inspect");
	assert.deepEqual((reviewerTool as any).parameters.properties, {});
	assert.equal(gitInspectToolForAgent({ tools: ["read"] }, cwd), undefined);
	assert.equal(gitInspectToolForAgent({}, cwd), undefined);

	// A diff larger than spawnSync's bounded buffer still returns a useful capped
	// prefix and does not hide the following section behind ENOBUFS.
	fs.writeFileSync(path.join(cwd, "tracked.txt"), `${"large staged line\n".repeat(12_000)}`);
	run("add", "tracked.txt");
	const large = inspectGitRepository(cwd);
	assert.match(large, /## Staged diff[\s\S]*\[truncated at 16KB\]/);
	assert.doesNotMatch(large, /ENOBUFS/);
	assert.match(large, /## Unstaged diff/);

	// Repository-controlled clean/process filters are detected through metadata
	// before status/diff can execute them.
	const hostile = fs.mkdtempSync(path.join(os.tmpdir(), "git-inspect-filter-"));
	try {
		const hostileRun = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: hostile, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		};
		hostileRun("init", "-q");
		hostileRun("config", "user.name", "Test");
		hostileRun("config", "user.email", "test@example.com");
		const unusualName = "line\nbreak.txt";
		fs.writeFileSync(path.join(hostile, ".gitattributes"), "*.txt filter=hostile\n");
		fs.writeFileSync(path.join(hostile, unusualName), "safe\n");
		// Linux permits non-UTF-8 path bytes; they must pass through the NUL
		// protocol unchanged. macOS rejects such filenames at the filesystem API.
		if (process.platform === "linux") {
			const nonUtf8Name = Buffer.concat([Buffer.from(`${hostile}/bad`), Buffer.from([0xff]), Buffer.from(".txt")]);
			fs.writeFileSync(nonUtf8Name, "safe\n");
		}
		hostileRun("add", "-A");
		hostileRun("commit", "-qm", "base");
		const marker = path.join(hostile, "FILTER_RAN");
		hostileRun("config", "filter.hostile.clean", `touch ${marker}`);
		fs.writeFileSync(path.join(hostile, unusualName), "changed\n");

		const refused = inspectGitRepository(hostile);
		assert.match(refused, /inspection refused: active repository-configured external clean\/process filters/i);
		assert.match(refused, /hostile/);
		assert.equal(fs.existsSync(marker), false, "inspection must never execute the configured filter");

		const overflow = inspectGitRepository(hostile, 16);
		assert.match(overflow, /unable to inspect repository filters safely/i, "incomplete metadata must fail closed");
		assert.equal(fs.existsSync(marker), false);

		// Any metadata command failure is likewise a refusal, not permission to
		// continue to commands that can execute filters.
		fs.writeFileSync(path.join(hostile, ".git", "config"), "[broken\n");
		const metadataError = inspectGitRepository(hostile);
		assert.match(metadataError, /unable to inspect repository filters safely/i);
	} finally {
		fs.rmSync(hostile, { recursive: true, force: true });
	}
} finally {
	fs.rmSync(cwd, { recursive: true, force: true });
}

console.log("git inspect unit tests passed");
