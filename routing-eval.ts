import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface RoutingEvalCase {
	id: string;
	prompt: string;
	expect: string[];
	reject: string[];
	/** Additional known agents permitted without being required. Expected spawns are exhaustive otherwise. */
	allowExtra?: string[];
	/** Required spawn subsequence when specialist ownership has a meaningful order. */
	expectOrder?: string[];
	/** Where the case runs. "fixture" = a fresh throwaway scratch project (safe to
	 * mutate — used for any case whose flow may edit files). "repo" (default) = this
	 * extension's directory, for read-only breadth/recon cases that need a real
	 * codebase's size. NEVER point a mutation-capable prompt at repo files. */
	cwd?: "repo" | "fixture";
	notes: string;
}

/** The scratch project mutation-capable cases run against: small, self-contained,
 * deterministic. Regenerated fresh per case so edits can't leak between runs. */
export const FIXTURE_FILES: Record<string, string> = {
	"package.json": `{\n\t"name": "routing-eval-fixture",\n\t"type": "module",\n\t"scripts": { "test": "node test.js" }\n}\n`,
	"README.md": "# Fixture\n\nA tiny scratch project used by the subagents routing eval.\n",
	"src/keymap.ts": [
		'export const DEFAULT_KEYS: Record<string, string> = { up: "k", down: "j", toggle: "space" };',
		"",
		"export function matchKey(action: string, key: string): boolean {",
		"\treturn DEFAULT_KEYS[action] === key;",
		"}",
		"",
	].join("\n"),
	"src/dashboard.ts": [
		'import { DEFAULT_KEYS, matchKey } from "./keymap.ts";',
		"",
		'export const ACTIONS = ["up", "down", "toggle"];',
		"",
		"export function handleKey(key: string): string | null {",
		"\tfor (const a of ACTIONS) if (matchKey(a, key)) return a;",
		"\treturn null;",
		"}",
		"",
		"export function hints(): string[] {",
		"\treturn ACTIONS.map((a) => `${DEFAULT_KEYS[a]}: ${a}`);",
		"}",
		"",
	].join("\n"),
	"src/settings.ts": [
		'import { DEFAULT_KEYS } from "./keymap.ts";',
		"",
		"export function rebind(action: string, key: string): void {",
		"\tif (action in DEFAULT_KEYS) DEFAULT_KEYS[action] = key;",
		"}",
		"",
	].join("\n"),
	"src/theme-colors.ts": [
		'export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴"];',
		"",
		"export function frameAt(i: number): string {",
		"\treturn SPINNER_FRAMES[i % SPINNER_FRAMES.length];",
		"}",
		"",
	].join("\n"),
};

export function createFixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-routing-eval-"));
	for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
		const fp = path.join(dir, rel);
		fs.mkdirSync(path.dirname(fp), { recursive: true });
		fs.writeFileSync(fp, content, "utf-8");
	}
	return dir;
}

export interface RoutingEvalResult {
	id: string;
	pass: boolean;
	spawned: string[];
	missing: string[];
	forbidden: string[];
	unknown: string[];
	exitCode: number | null;
	durationMs: number;
	/** The child pi run was killed at the time limit. Spawn assertions are still
	 * valid (spawns are logged as they happen), but the run never completed. */
	timedOut: boolean;
	/** The first attempt died as an infra failure (crash before any routing happened)
	 * and this result comes from the automatic rerun. */
	retried?: boolean;
	notes: string;
}

/** Cheap subset to run after every description/guidance edit: the two no-spawn
 * guards plus one representative of each hard trigger. The full suite is for
 * pre-merge; this is the per-edit smoke check. */
export const FAST_CASE_IDS = [
	"known-file-no-scout",
	"obvious-symbol-no-scout",
	"trivial-diff-inline-review",
	"small-edit-inline",
	"known-failure-debugger",
];

/** A crash before any routing happened (non-zero exit, no spawns, not a timeout)
 * says nothing about routing — rerun it instead of reporting a false FAIL. */
export function isInfraFailure(r: Pick<RoutingEvalResult, "exitCode" | "timedOut" | "spawned">): boolean {
	return !r.timedOut && r.exitCode !== 0 && r.spawned.length === 0;
}

export function routingAgentNames(agentDir = path.join(os.homedir(), ".pi", "agent", "agents")): string[] {
	try {
		return fs.readdirSync(agentDir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -3));
	} catch {
		return [];
	}
}

export const ROUTING_EVAL_CASES: RoutingEvalCase[] = [
	{
		id: "known-file-no-scout",
		prompt: "In src/keymap.ts, where is DEFAULT_KEYS defined? Answer directly from that known file.",
		expect: [],
		reject: ["scout"],
		cwd: "fixture",
		notes: "Familiarity tripwire: if the file is named, recon should stay inline.",
	},
	{
		id: "obvious-symbol-no-scout",
		prompt: "Where is the SPINNER_FRAMES constant defined in this project? Use a quick direct search yourself; do not delegate unless many files are needed.",
		expect: [],
		reject: ["scout"],
		cwd: "fixture",
		notes: "Over-delegation guard for a simple grep-scale lookup.",
	},
	{
		id: "broad-flow-scout",
		prompt: "Trace the lifecycle of a model-tool-started multi-agent sequence through the extension, from tool dispatch to child session execution and final output. Return the file:line path.",
		expect: ["scout"],
		reject: [],
		notes: "Breadth tripwire: cross-file unfamiliar tracing should delegate recon.",
	},
	{
		id: "broad-state-scout",
		prompt: "Map every place persistent subagent state is read, changed, and rendered in the dashboard. Return a concise architecture map.",
		expect: ["scout"],
		reject: [],
		notes: "Breadth tripwire for many-file state reconnaissance.",
	},
	{
		id: "known-failure-debugger",
		prompt: "`npm test` just exited non-zero with TypeError: matchKey is not a function thrown from src/dashboard.ts. There is a known failing symptom and no diff to review; root-cause the failure.",
		expect: ["debugger"],
		reject: ["reviewer"],
		allowExtra: ["scout"],
		cwd: "fixture",
		notes: "Discipline event: known failing symptom belongs to debugger, not reviewer.",
	},
	{
		id: "review-before-commit",
		prompt: "Before committing the current subagents extension changes, review the diff for correctness and information-design regressions.",
		expect: ["reviewer"],
		reject: ["debugger"],
		notes: "Discipline event: clean diff vetting belongs to reviewer.",
	},
	{
		id: "trivial-diff-inline-review",
		prompt: "I changed one comment in README.md. Decide whether a specialist review is needed before saying done.",
		expect: [],
		reject: ["reviewer"],
		cwd: "fixture",
		notes: "Review tripwire: trivial diffs should be reviewed inline.",
	},
	{
		id: "tests-primary-deliverable",
		prompt: "Write focused tests for src/keymap.ts matchKey; tests are the primary deliverable.",
		expect: ["test-writer"],
		reject: ["worker"],
		cwd: "fixture",
		notes: "Deliberate test-writing task.",
	},
	{
		id: "planning-artifact-only",
		prompt: "Produce a written implementation plan for adding per-agent advertise tiers. Do not edit files.",
		expect: ["planner"],
		reject: ["worker"],
		notes: "Planner is allowed when the plan artifact is the deliverable.",
	},
	{
		id: "implementation-not-planner",
		prompt: "Implement the planned change to add a new 'select' action: wire it through src/keymap.ts, src/dashboard.ts, and src/settings.ts, keep everything compiling, and self-review the diff.",
		expect: [],
		reject: ["planner"],
		allowExtra: ["worker", "reviewer", "test-writer"],
		cwd: "fixture",
		notes: "Implementation must never route to planner. Worker OR inline are both acceptable: worker is judgment-tier and its tripwire (edit churn crowding main context) cannot fairly trip in a tiny fixture, so demanding a worker spawn here would force over-firing in real use.",
	},
	{
		id: "small-edit-inline",
		prompt: "In src/theme-colors.ts, rename the exported constant SPINNER_FRAMES to SPINNER_GLYPHS and update its references in that file. A small nameable edit.",
		expect: [],
		reject: ["worker", "scout"],
		cwd: "fixture",
		notes: "Scale gate: a small edit in known files stays inline, no worker spawn.",
	},
	{
		id: "oracle-challenges-plan",
		prompt: "Use oracle to challenge this proposed decision before we act: replace DEFAULT_KEYS with mutable global state. Do not create a new implementation plan or edit.",
		expect: ["oracle"],
		reject: ["planner", "worker"],
		cwd: "fixture",
		notes: "Oracle challenges an existing decision; planner creates plans.",
	},
	{
		id: "known-failure-not-test-writer",
		prompt: "A focused keymap test is already failing with AssertionError for matchKey. Diagnose and fix this known failure; do not write broad new coverage.",
		expect: ["debugger"],
		reject: ["test-writer"],
		allowExtra: ["scout", "reviewer"],
		cwd: "fixture",
		notes: "An existing failing test is debugger work, not a test-writing artifact request.",
	},
	{
		id: "plan-then-implement-same-request",
		prompt: "First create and present a concrete plan for adding a select action across src/keymap.ts, src/dashboard.ts, and src/settings.ts, then use the implementation coordinator to implement it in this same request and review the final diff. Do not wait for another approval because this message explicitly asks for both.",
		expect: ["planner", "worker", "reviewer"],
		reject: [],
		allowExtra: ["test-writer"],
		expectOrder: ["planner", "worker", "reviewer"],
		cwd: "fixture",
		notes: "Planner must run, then the explicit same-message request continues through coordinated implementation and final review.",
	},
];

export function parseSpawnedAgents(output: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const add = (raw: string) => {
		const name = raw.trim().toLowerCase();
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || seen.has(name)) return;
		seen.add(name);
		found.push(name);
	};

	for (const match of output.matchAll(/^SUBAGENT_EVAL_SPAWN\s+([a-z0-9-]+)$/gim)) add(match[1].toLowerCase());
	return found;
}

export function compareSpawned(
	spawned: string[],
	rule: Pick<RoutingEvalCase, "expect" | "reject" | "allowExtra" | "expectOrder">,
	knownNames = routingAgentNames(),
): Pick<RoutingEvalResult, "pass" | "missing" | "forbidden" | "unknown"> {
	const spawnedSet = new Set(spawned);
	const missing = rule.expect.filter((name) => !spawnedSet.has(name));
	const known = new Set(knownNames);
	const unknown = spawned.filter((name) => !known.has(name));
	const allowed = new Set([...rule.expect, ...(rule.allowExtra ?? [])]);
	const forbidden = [...new Set([
		...rule.reject.filter((name) => spawnedSet.has(name)),
		...spawned.filter((name) => known.has(name) && !allowed.has(name)),
	])];
	const ordered = rule.expectOrder ?? [];
	let cursor = -1;
	const orderOk = ordered.every((name) => {
		cursor = spawned.indexOf(name, cursor + 1);
		return cursor >= 0;
	});
	if (!orderOk) missing.push(`order:${ordered.join("→")}`);
	return { pass: missing.length === 0 && forbidden.length === 0 && unknown.length === 0, missing, forbidden, unknown };
}

export function routingPass(assertionsPass: boolean, timedOut: boolean, exitCode: number | null): boolean {
	return assertionsPass && !timedOut && exitCode === 0;
}

function runOne(c: RoutingEvalCase, repoDir: string, workDir: string): RoutingEvalResult {
	const started = Date.now();
	const proc = spawnSync("pi", ["-p", "-e", path.join(repoDir, "index.ts"), "--no-extensions", "--no-session", c.prompt], {
		cwd: workDir,
		encoding: "utf-8",
		env: { ...process.env, SUBAGENT_ROUTING_EVAL: "1" },
		timeout: 180_000,
	});
	const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
	const spawned = parseSpawnedAgents(output);
	const compared = compareSpawned(spawned, c);
	// A timed-out run is inconclusive even if its early spawn prefix happened to match.
	const timedOut = proc.signal === "SIGTERM" || proc.status === 143;
	return {
		id: c.id,
		...compared,
		pass: routingPass(compared.pass, timedOut, proc.status),
		spawned,
		exitCode: proc.status,
		durationMs: Date.now() - started,
		timedOut,
		notes: c.notes,
	};
}

/** Fixture cases get a fresh scratch project each attempt (edits must not leak);
 * repo cases run in the extension directory itself and must stay read-only. */
function runOneWithRetry(c: RoutingEvalCase, repoDir: string): RoutingEvalResult {
	const attempt = (): RoutingEvalResult => {
		if (c.cwd !== "fixture") return runOne(c, repoDir, repoDir);
		const fixture = createFixture();
		try {
			return runOne(c, repoDir, fixture);
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	};
	const first = attempt();
	if (!isInfraFailure(first)) return first;
	console.log(`  (infra failure on ${c.id} — exit ${first.exitCode} after ${first.durationMs}ms, no spawns; retrying once)`);
	return { ...attempt(), retried: true };
}

function main(): void {
	const cwd = path.dirname(fileURLToPath(import.meta.url));
	const args = new Set(process.argv.slice(2));
	const baselinePath = path.join(cwd, "routing-eval-baseline.json");
	const outputArg = process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : "";
	const outputPath = outputArg ? path.resolve(cwd, outputArg) : "";
	const selected = process.argv.includes("--case")
		? new Set([process.argv[process.argv.indexOf("--case") + 1]])
		: args.has("--fast")
			? new Set(FAST_CASE_IDS)
			: null;
	const cases = selected ? ROUTING_EVAL_CASES.filter((c) => selected.has(c.id)) : ROUTING_EVAL_CASES;

	if (args.has("--list")) {
		for (const c of ROUTING_EVAL_CASES) console.log(`${c.id}: expect=[${c.expect.join(",") || "-"}] reject=[${c.reject.join(",") || "-"}]`);
		return;
	}

	const results: RoutingEvalResult[] = [];
	for (const c of cases) {
		const r = runOneWithRetry(c, cwd);
		results.push(r);
		const status = r.pass ? "PASS" : "FAIL";
		const flags = `${r.timedOut ? " [timeout]" : ""}${r.retried ? " [retried]" : ""}`;
		console.log(`${status} ${r.id} spawned=[${r.spawned.join(",") || "-"}] missing=[${r.missing.join(",") || "-"}] forbidden=[${r.forbidden.join(",") || "-"}] unknown=[${r.unknown.join(",") || "-"}]${flags}`);
	}
	const report = {
		generatedAt: new Date().toISOString(),
		command: "pi -p -e index.ts --no-extensions --no-session <prompt>",
		results,
		summary: {
			total: results.length,
			passed: results.filter((r) => r.pass).length,
			failed: results.filter((r) => !r.pass).length,
		},
	};

	if (args.has("--write-baseline")) fs.writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
	if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

	console.log(`summary: ${report.summary.passed}/${report.summary.total} passed`);
	if (!args.has("--write-baseline") && report.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
