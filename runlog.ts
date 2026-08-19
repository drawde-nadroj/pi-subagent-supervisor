import * as fs from "node:fs";
import * as path from "node:path";
import type { RunRecord } from "./registry.ts";

export { getDefaultRunLogPath } from "./storage.ts";

/** One finished run, persisted as a JSON line in runs.jsonl. This is the feedback
 * loop for delegation tuning: aggregate it (`/agents stats`) to see whether each
 * agent's spawns actually pay for themselves across sessions. */
export interface RunLogEntry {
	ts: string;
	agent: string;
	mode: "single" | "parallel" | "chain";
	status: string;
	durationMs: number;
	/** Run cost including nested spawn children. */
	cost: number;
	input: number;
	output: number;
	tools: number;
	task: string;
	/** Failure reason (truncated), when the run did not succeed. Drives the per-agent
	 * failure-mode breakdown so `fail 3` becomes `fail 3 (2 timeout, 1 turn-limit)`. */
	error?: string;
	/** Working directory the run executed in, for per-project cost breakdowns. */
	cwd?: string;
}

export function entryFromRecord(rec: RunRecord): RunLogEntry {
	const endedAt = rec.endedAt ?? Date.now();
	const startedAt = rec.startedAt ?? rec.plannedAt;
	const subtreeCost = (record: RunRecord): number =>
		(record.usage?.cost ?? 0) + record.children.reduce((sum, child) => sum + subtreeCost(child), 0);
	return {
		ts: new Date(endedAt).toISOString(),
		agent: rec.agentName,
		mode: rec.mode,
		status: rec.status === "success" ? "done" : rec.status,
		durationMs: endedAt - startedAt,
		cost: subtreeCost(rec),
		input: rec.usage?.input ?? 0,
		output: rec.usage?.output ?? 0,
		tools: rec.usage?.toolCalls ?? 0,
		task: rec.task.replace(/\s+/g, " ").slice(0, 80),
		error: rec.error ? rec.error.replace(/\s+/g, " ").slice(0, 120) : undefined,
		cwd: rec.cwd,
	};
}

/** Bucket a raw failure string into a stable short category, so runs that differ only
 * in a number ("timed out after 300s" vs "…250s") aggregate into one reason. */
export function failureCategory(error: string | undefined): string {
	if (!error) return "error";
	const e = error.toLowerCase();
	if (/timed out|timeout/.test(e)) return "timeout";
	if (/turn limit/.test(e)) return "turn-limit";
	if (/^aborted|\baborted\b/.test(e)) return "aborted";
	if (/quota|rate.?limit|\b429\b|billing|insufficient/.test(e)) return "quota";
	if (/auth|\b40[13]\b/.test(e)) return "auth";
	if (/\b5\d\d\b|overloaded|unavailable|econn|etimedout|enotfound|fetch failed|network|internal server/.test(e)) return "provider";
	if (/schema|json block/.test(e)) return "schema";
	if (/no model available/.test(e)) return "no-model";
	return "error";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep only entries newer than `days` days. days<=0 means "all time" (no filter). */
export function filterRecentEntries(entries: RunLogEntry[], days: number): RunLogEntry[] {
	if (days <= 0) return entries;
	const cutoff = Date.now() - days * DAY_MS;
	return entries.filter((e) => {
		const t = Date.parse(e.ts);
		return Number.isNaN(t) || t >= cutoff; // undated/corrupt ts: keep rather than silently drop
	});
}

/** Best-effort append; a broken log must never break a run. */
export function appendRunLog(file: string, entry: RunLogEntry): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.chmodSync(file, 0o600);
	} catch {
		/* best-effort */
	}
}

/** Read all entries, skipping blank/corrupt lines. Missing file = empty history. */
export function readRunLog(file: string): RunLogEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: RunLogEntry[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e = JSON.parse(t) as RunLogEntry;
			if (e && typeof e.agent === "string" && typeof e.cost === "number") out.push(e);
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

export interface AgentRunStats {
	agent: string;
	runs: number;
	failed: number;
	totalCost: number;
	avgCost: number;
	avgDurationMs: number;
	avgOutput: number;
	/** Failure reasons among this agent's failed runs, count per category, most common first. */
	failures: Array<{ category: string; count: number }>;
}

/** Order failure categories by count (desc), then name, for a stable readout. */
function summarizeFailures(list: RunLogEntry[]): Array<{ category: string; count: number }> {
	const counts = new Map<string, number>();
	for (const e of list) {
		if (e.status === "done") continue;
		const cat = failureCategory(e.error ?? (e.status === "aborted" ? "aborted" : undefined));
		counts.set(cat, (counts.get(cat) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([category, count]) => ({ category, count }))
		.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Per-agent aggregates, sorted by total cost descending (the tuning signal:
 * the top row is where your delegation money goes). */
export function aggregateRunStats(entries: RunLogEntry[]): AgentRunStats[] {
	const byAgent = new Map<string, RunLogEntry[]>();
	for (const e of entries) {
		const list = byAgent.get(e.agent) ?? [];
		list.push(e);
		byAgent.set(e.agent, list);
	}
	const stats: AgentRunStats[] = [];
	for (const [agent, list] of byAgent) {
		const totalCost = list.reduce((s, e) => s + e.cost, 0);
		stats.push({
			agent,
			runs: list.length,
			failed: list.filter((e) => e.status !== "done").length,
			totalCost,
			avgCost: totalCost / list.length,
			avgDurationMs: list.reduce((s, e) => s + e.durationMs, 0) / list.length,
			avgOutput: list.reduce((s, e) => s + e.output, 0) / list.length,
			failures: summarizeFailures(list),
		});
	}
	stats.sort((a, b) => b.totalCost - a.totalCost);
	return stats;
}

function fmtMs(ms: number): string {
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Aligned monospace table for the /agents stats transcript message. `windowLabel`
 * names the time span the numbers cover (e.g. "last 30 days" / "all sessions"). */
export function formatRunStats(stats: AgentRunStats[], windowLabel = "all sessions"): string[] {
	if (stats.length === 0) return [`No subagent runs logged (${windowLabel}).`];
	const nameW = Math.max(5, ...stats.map((s) => s.agent.length));
	const header = `${"agent".padEnd(nameW)}  runs  fail   total $     avg $  avg time  avg ↓out`;
	const rows = stats.map(
		(s) =>
			`${s.agent.padEnd(nameW)}  ${String(s.runs).padStart(4)}  ${String(s.failed).padStart(4)}  ${s.totalCost.toFixed(4).padStart(8)}  ${s.avgCost.toFixed(4).padStart(8)}  ${fmtMs(s.avgDurationMs).padStart(8)}  ${String(Math.round(s.avgOutput)).padStart(8)}`,
	);
	// Failure-mode breakdown: one line per agent that actually failed, so a bare
	// "fail 3" becomes actionable ("2 timeout, 1 provider") without widening the table.
	const failLines = stats
		.filter((s) => s.failed > 0)
		.map((s) => `  ${s.agent}: ${s.failures.map((f) => `${f.count} ${f.category}`).join(", ")}`);
	const total = stats.reduce((s, a) => s + a.totalCost, 0);
	const runs = stats.reduce((s, a) => s + a.runs, 0);
	const out = [header, ...rows];
	if (failLines.length) out.push("", "failures:", ...failLines);
	out.push(`${runs} runs · $${total.toFixed(4)} total · ${windowLabel} · nested spawn cost included`);
	return out;
}
