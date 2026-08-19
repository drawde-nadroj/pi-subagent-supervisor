import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearDiscoverCache, discoverAgents } from "./agents.ts";
import { materializeUserOverride } from "./agent-writer.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-discovery-"));
const agentDir = path.join(root, "home");
const project = path.join(root, "project", "nested");
process.env.PI_CODING_AGENT_DIR = agentDir;
const write = (dir: string, name: string, description: string) => {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nPrompt\n`);
};

fs.mkdirSync(project, { recursive: true });
clearDiscoverCache();
let roster = discoverAgents(project, { includeProject: false }).agents;
const bundledWorker = roster.find((agent) => agent.name === "worker");
assert.equal(bundledWorker?.source, "bundled", "bundled roster loads without user copies");
const copied = materializeUserOverride(bundledWorker!);
assert.equal(copied.source, "user");
assert.equal(copied.filePath, path.join(agentDir, "agents", "worker.md"));
assert.ok(fs.existsSync(copied.filePath));
const sameIdentityCopy = materializeUserOverride({ ...bundledWorker!, description: "updated bundled override" });
assert.equal(sameIdentityCopy.filePath, copied.filePath, "the standard path remains in use for the same identity");
assert.match(fs.readFileSync(copied.filePath, "utf-8"), /description: updated bundled override/);
fs.rmSync(path.join(agentDir, "agents"), { recursive: true });

const userAgentsDir = path.join(agentDir, "agents");
fs.mkdirSync(userAgentsDir, { recursive: true });
const legacyTestWriter = path.join(userAgentsDir, "test-writer.md");
fs.writeFileSync(legacyTestWriter, "---\nname: test writer\ndescription: customized legacy description\n---\nCustomized legacy body\n", "utf-8");
clearDiscoverCache();
roster = discoverAgents(project, { includeProject: false }).agents;
const testWriters = roster.filter((agent) => agent.name === "test-writer");
assert.equal(testWriters.length, 1, "legacy user copy replaces the bundled durable identity");
assert.equal(testWriters[0].source, "user");
assert.equal(testWriters[0].filePath, legacyTestWriter);
assert.equal(testWriters[0].description, "customized legacy description");
assert.equal(testWriters[0].systemPrompt, "Customized legacy body");
assert.equal(roster.some((agent) => agent.name === "test writer"), false);
fs.rmSync(userAgentsDir, { recursive: true });

fs.mkdirSync(userAgentsDir, { recursive: true });
const occupiedWorker = path.join(userAgentsDir, "worker.md");
const occupiedBytes = "---\nname: someone-else\ndescription: keep me\n---\nOriginal bytes\n";
fs.writeFileSync(occupiedWorker, occupiedBytes, "utf-8");
const collisionCopy = materializeUserOverride(bundledWorker!);
assert.equal(fs.readFileSync(occupiedWorker, "utf-8"), occupiedBytes, "a different identity is never overwritten");
assert.equal(collisionCopy.filePath, path.join(userAgentsDir, "worker-override.md"));
assert.equal(fs.readFileSync(collisionCopy.filePath, "utf-8").includes("name: worker"), true);
assert.throws(() => materializeUserOverride(bundledWorker!), { code: "EEXIST" });
assert.equal(fs.existsSync(path.join(userAgentsDir, "worker-override-2.md")), false);
assert.equal(fs.readFileSync(occupiedWorker, "utf-8"), occupiedBytes);
fs.rmSync(userAgentsDir, { recursive: true });

const bundledPlanner = roster.find((agent) => agent.name === "planner" && agent.source === "bundled")!;
fs.mkdirSync(userAgentsDir, { recursive: true });
const malformedPlanner = path.join(userAgentsDir, "planner.md");
fs.writeFileSync(malformedPlanner, "not frontmatter\n", "utf-8");
const malformedCopy = materializeUserOverride(bundledPlanner);
assert.equal(fs.readFileSync(malformedPlanner, "utf-8"), "not frontmatter\n");
assert.equal(malformedCopy.filePath, path.join(userAgentsDir, "planner-override.md"));
fs.rmSync(userAgentsDir, { recursive: true });

write(path.join(agentDir, "agents"), "worker", "user override");
write(path.join(root, "project", ".claude", "agents"), "worker", "claude override");
write(path.join(root, "project", ".pi", "agents"), "worker", "native override");
clearDiscoverCache();
roster = discoverAgents(project, { includeProject: true }).agents;
assert.equal(roster.find((agent) => agent.name === "worker")?.description, "native override");

fs.rmSync(path.join(root, "project", ".pi"), { recursive: true });
clearDiscoverCache();
roster = discoverAgents(project, { includeProject: true }).agents;
assert.equal(roster.find((agent) => agent.name === "worker")?.description, "claude override");

fs.rmSync(path.join(root, "project", ".claude"), { recursive: true });
clearDiscoverCache();
roster = discoverAgents(project, { includeProject: true }).agents;
assert.equal(roster.find((agent) => agent.name === "worker")?.description, "user override");

fs.rmSync(path.join(agentDir, "agents"), { recursive: true });
clearDiscoverCache();
roster = discoverAgents(project, { includeProject: true }).agents;
assert.equal(roster.find((agent) => agent.name === "worker")?.source, "bundled");
fs.rmSync(root, { recursive: true, force: true });
console.log("discovery tests passed");
