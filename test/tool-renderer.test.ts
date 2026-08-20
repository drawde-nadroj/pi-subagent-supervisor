import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage } from "../src/engine.ts";
import { formatLiveSurface } from "../src/live-surface.ts";
import { RESULT_CAP_BYTES, type CallSnapshot, type RunNodeSnapshot, type RunNodeStatus } from "../src/registry.ts";
import { activityForRole, formatAgentIdentityLine } from "../src/tree-presentation.ts";
import {
	normalizeV2Details,
	renderSubagentCall,
	renderSubagentResult,
	type SubagentRendererContext,
	type SubagentRendererState,
	type SubagentRendererTheme,
	type SubagentToolDetailsV2,
} from "../src/tool-renderer.ts";

initTheme(undefined, false);
const theme: SubagentRendererTheme = { fg: (_color, text) => text, bold: (text) => text };
assert.deepEqual(
	["debugger", "oracle", "planner", "reviewer", "scout", "test-writer", "worker", "tldraw-offline", "custom"].map(activityForRole),
	["exorcising", "divining", "scheming", "scrutineering", "spelunking", "tripwiring", "tinkering", "doodling", "working"],
);
let id = 1;
const node = (overrides: Partial<RunNodeSnapshot> = {}): RunNodeSnapshot => {
	const status: RunNodeStatus = overrides.status ?? "success";
	return {
		id: id++, callId: 1, role: "worker", persona: { base: "Ada", friendDepth: 0 }, color: "cyan",
		task: "Implement a carefully scoped change", status, plannedAt: 1, startedAt: status === "dormant" ? undefined : 2,
		finishedAt: status === "active" || status === "dormant" ? undefined : 3, durationMs: 2_000,
		usage: { ...emptyUsage(), input: 12, output: 8, toolCalls: 2, cost: 0.0123 }, model: "mock/model",
		contextPercent: null, activity: { type: status === "active" ? "tool" : "finished", at: 3, tool: "edit", text: "edit tool-renderer.ts" },
		toolLog: status === "active" ? ["edit tool-renderer.ts"] : ["read tool-renderer.ts"],
		finalText: status === "success" ? "Child summary" : undefined, error: status === "error" ? "Child error" : undefined,
		ownCost: 0.0123, subtreeCost: 0.0123, children: [], ...overrides,
	};
};
const all = (roots: RunNodeSnapshot[]): RunNodeSnapshot[] => roots.flatMap((root) => [root, ...all(root.children)]);
const snapshot = (roots: RunNodeSnapshot[]): CallSnapshot => {
	const nodes = all(roots);
	const finished = nodes.filter((n) => n.status !== "active" && n.status !== "dormant");
	return {
		id: 1, mode: "single", launchSurface: "foreground", revision: 1, createdAt: 1, finishedAt: nodes.length === finished.length ? 3 : undefined,
		durationMs: 2_000, counts: { total: nodes.length, dormant: nodes.filter((n) => n.status === "dormant").length, active: nodes.filter((n) => n.status === "active").length, finished: finished.length, failed: nodes.filter((n) => n.status === "error").length },
		totalCost: roots.reduce((sum, root) => sum + root.subtreeCost, 0), roots,
	};
};
const details = (roots: RunNodeSnapshot[]): SubagentToolDetailsV2 => ({ schemaVersion: 2, revision: 1, call: snapshot(roots) });
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9:;]*m/g, "");
const flattenRailContent = (text: string) => text.replace(/^(?:│  )+/gm, "").replace(/\s+/g, " ");
function render(value: unknown, options: { expanded?: boolean; partial?: boolean; showCosts?: boolean; width?: number; now?: number } = {}) {
	const state: SubagentRendererState = { showCosts: options.showCosts ?? false, now: () => options.now ?? 0 };
	const args = { agent: "worker", task: "implement" };
	const context: SubagentRendererContext = { args, state, lastComponent: undefined };
	const header = renderSubagentCall(args, theme, context);
	const body = renderSubagentResult({ content: [{ type: "text", text: "combined result" }], details: value }, { expanded: options.expanded ?? false, isPartial: options.partial ?? false }, theme, { ...context, lastComponent: undefined });
	const width = options.width ?? 80;
	return { header: header.render(width), body: body.render(width), all: [...header.render(width), ...body.render(width)] };
}

// The temporal label appears only before a result exists; terminal fallbacks
// must not look like work is still being dispatched.
const initialState: SubagentRendererState = {};
const initialArgs = { agent: "worker", task: "implement" };
const initialContext: SubagentRendererContext = { args: initialArgs, state: initialState, lastComponent: undefined };
assert.equal(plain(renderSubagentCall({}, theme, { args: {}, state: {}, lastComponent: undefined }).render(80)), "calling for help...");
assert.equal(plain(renderSubagentCall(initialArgs, theme, initialContext).render(80)), "found worker");
const invalid = render(undefined);
assert.equal(plain(invalid.header), "");
assert.match(plain(invalid.body), /combined result/);
const empty = render(details([]));
assert.equal(plain(empty.header), "");
assert.match(plain(empty.body), /combined result/);
const malformed = render({ schemaVersion: 2 });
assert.equal(plain(malformed.header), "");
assert.match(plain(malformed.body), /Invalid stored subagent details/);
const dormant = render(details([node({ status: "dormant", usage: emptyUsage(), ownCost: 0, subtreeCost: 0 })]));
assert.equal(plain(dormant.header), "");
assert.match(plain(dormant.body), /○ Ada · worker · waiting\n   Implement a carefully scoped change/);
assert.doesNotMatch(plain(dormant.all), /dormant|single|active|finished|\$/i);

// Rows replace the generic header, and planned descendants remain visibly waiting.
const active = render(details([node({ status: "active", children: [node({ status: "dormant", task: "waiting child task", usage: emptyUsage(), ownCost: 0, subtreeCost: 0 })] })]));
assert.equal(plain(active.header), "");
assert.match(plain(active.body), /○ Ada · worker · waiting for worker · 0:02[\s\S]*used edit! · Implement a carefully scoped change[\s\S]*○ Ada · worker · waiting[\s\S]*waiting child task/);
assert.doesNotMatch(plain(active.all), /dormant|single|finished/i);

// Live elapsed time is projected when the same component renders: no updated
// snapshot is needed, and every active nested row advances from its own start.
const liveClockTree = details([node({
	status: "active",
	startedAt: 1_000,
	durationMs: 0,
	children: [node({ status: "active", startedAt: 2_000, durationMs: 0 })],
})]);
let clockNow = 2_900;
const liveClockState: SubagentRendererState = { now: () => clockNow };
const liveClockContext: SubagentRendererContext = { args: initialArgs, state: liveClockState, lastComponent: undefined };
const liveClockBody = renderSubagentResult(
	{ content: [{ type: "text", text: "running" }], details: liveClockTree },
	{ expanded: false, isPartial: true },
	theme,
	liveClockContext,
);
const firstClockFrame = plain(liveClockBody.render(80));
clockNow = 4_100;
liveClockBody.invalidate();
const secondClockFrame = plain(liveClockBody.render(80));
assert.match(firstClockFrame, /waiting for worker · 0:01[\s\S]*tinkering · 0:00/);
assert.match(secondClockFrame, /waiting for worker · 0:03[\s\S]*tinkering · 0:02/);
assert.deepEqual(liveClockTree.call.roots.map((root) => [root.durationMs, root.children[0]?.durationMs]), [[0, 0]], "render-time clocks must not mutate stored details");

// Partial snapshots show live tree/activity but withhold potentially large child
// answers until Pi materializes the authoritative terminal result.
const partial = render(details([node({
	status: "active",
	children: [node({ status: "success", finalText: "EARLY CHILD ANSWER" })],
})]), { partial: true, expanded: true });
assert.match(plain(partial.body), /Implement a carefully scoped change/);
assert.match(plain(partial.body), /Activity/);
assert.doesNotMatch(plain(partial.body), /EARLY CHILD ANSWER|Returned/);

// Finished roots lead with the child summary rather than orchestration metadata.
const answer = Array.from({ length: 12 }, (_, i) => `SUMMARY ${i + 1}`).join("\n\n");
const terminal = render(details([node({ finalText: answer, task: "Implement a carefully scoped change" })]));
assert.match(plain(terminal.body), /Ada[^\n]*↑12 ↓8/);
assert.match(plain(terminal.body), /Implement a carefully scoped change[\s\S]*Returned[\s\S]*SUMMARY 1/);
assert.match(plain(terminal.body), /SUMMARY 12/);
assert.doesNotMatch(plain(terminal.body), /ctrl\+o/);
const expanded = render(details([node({ finalText: answer, task: "TASK", toolLog: ["LOG"] })]), { expanded: true });
assert.match(plain(expanded.body), /Returned[\s\S]*SUMMARY 12/);
assert.equal(plain(expanded.body).split("\n").filter((line) => /^│\s+SUMMARY 1\s*$/.test(line)).length, 1, "full Markdown summary appears once inside the uninterrupted root rail");
assert.match(plain(expanded.body), /TASK[\s\S]*LOG/);

// Expanded output uses smooth name-to-name connectors only for nested agent
// identities; task and section details remain unboxed.
const nestedGrandchild = node({
	parentId: 998,
	role: "scout",
	persona: { base: "Lin", friendDepth: 0 },
	color: "green",
	task: "Inspect the implementation",
	finalText: "Inspection summary",
});
const nestedChild = node({
	parentId: 999,
	role: "reviewer",
	persona: { base: "Grace", friendDepth: 0 },
	color: "purple",
	task: "Review the change",
	finalText: "Review summary",
	children: [nestedGrandchild],
	subtreeCost: 0.0246,
});
const clarityDetails = details([node({
	persona: { base: "Ada", friendDepth: 0 },
	task: "Implement the change",
	finalText: "Implementation summary",
	children: [nestedChild],
	subtreeCost: 0.0369,
})]);
const clearCompact = plain(render(clarityDetails).body);
for (const summary of ["Implementation summary", "Review summary", "Inspection summary"]) {
	assert.match(clearCompact, new RegExp(summary), `compact output includes the full ${summary}`);
}
assert.ok(
	clearCompact.indexOf("Inspection summary") < clearCompact.indexOf("Review summary")
	&& clearCompact.indexOf("Review summary") < clearCompact.indexOf("Implementation summary"),
	"nested returns appear before the parent return",
);
assert.match(clearCompact, /\n╰─ ✓ Grace/, "compact output keeps its terminal child connector");
assert.match(clearCompact, /\n   ╰─ ✓ Lin/, "compact nested output keeps its terminal child connector");

// A completed child can be followed by another child. Keep the parent's rail
// unbroken through the first child's prompt and return until the sibling branch.
const compactSiblings = plain(render(details([node({
	children: [
		node({ parentId: 999, persona: { base: "Grace", friendDepth: 0 }, finalText: "First return" }),
		node({ parentId: 999, persona: { base: "Lin", friendDepth: 0 }, finalText: "Second return" }),
	],
})])).body).split("\n");
const firstSibling = compactSiblings.findIndex((line) => line.includes("├─ ✓ Grace"));
const secondSibling = compactSiblings.findIndex((line) => line.includes("╰─ ✓ Lin"));
assert.ok(firstSibling >= 0 && secondSibling > firstSibling, "compact siblings render in tree order");
assert.ok(
	compactSiblings.slice(firstSibling + 1, secondSibling).every((line) => line.startsWith("│")),
	"the compact parent rail stays continuous through the non-terminal sibling return",
);
const clearExpandedLines = render(clarityDetails, { expanded: true }).body;
const clearExpandedAnsi = clearExpandedLines.join("\n");
const clearExpanded = plain(clearExpandedLines);
for (const label of ["Ada", "Implement the change", "Activity", "Delegated", "Grace", "Review the change", "Lin", "Inspect the implementation", "Returned", "Details"]) {
	assert.match(clearExpanded, new RegExp(label));
}
assert.match(clearExpanded, /✓ Ada[^\n]*\n│  used edit! · Implement the change[\s\S]*\n├─ ✓ Grace[^\n]*\n│  │  used edit! · Review the change[\s\S]*\n│  ├─ ✓ Lin[^\n]*\n│  │  │  used edit! · Inspect the implementation/);
assert.doesNotMatch(clearExpanded, /[├└╰]─ (?:used edit|Activity|Delegated|Returned|Details)/);
assert.match(clearExpandedAnsi, /\x1b\[38;2;95;199;196m├─\x1b\[39m/, "the child connector uses the root caller color");
assert.match(clearExpandedAnsi, /\x1b\[38;2;186;134;232m├─\x1b\[39m/, "the grandchild connector switches to its immediate caller color");
assert.match(clearExpanded, /\n│  Delegated\n├─ ✓ Grace/, "the root rail continues into its nested reviewer");
assert.match(clearExpanded, /\n│  │  Delegated\n│  ├─ ✓ Lin/, "both ancestor rails continue into the nested scout");
assert.match(
	clearExpanded,
	/\n│  ├─ ✓ Lin[\s\S]*\n│  │  │  Returned\n[\s\S]*\n│  │  │  Details\n[\s\S]*\n│  │  Returned\n[\s\S]*\n│  │  Details\n[\s\S]*\n│  Returned\n[\s\S]*\n│  Details/,
	"every expanded ancestor rail remains visible through descendants and parent tails",
);
for (const width of [20, 24, 80]) {
	for (const expandedState of [false, true]) {
		const rendered = render(clarityDetails, { expanded: expandedState, width }).body;
		assert.ok(rendered.every((line) => visibleWidth(line) <= width), `${expandedState ? "expanded" : "collapsed"} tree fits width ${width}`);
	}
	const atWidth = plain(render(clarityDetails, { expanded: true, width }).body);
	assert.match(atWidth, /\n│  Delegated\n├─ ✓ /, `root rail survives expanded width ${width}`);
	assert.match(atWidth, /\n│  │  Delegated\n│  ├─ ✓ /, `nested ancestor rails survive expanded width ${width}`);
}

// At the deepest supported spawn level, narrow body lines drop optional
// indentation before they drop any current or ancestor rail.
let deepestSupported = node({
	task: "deep",
	activity: { type: "finished", at: 3 },
	toolLog: ["x"],
	finalText: "answer",
});
for (let depth = 0; depth < 3; depth++) {
	deepestSupported = node({ task: `parent ${depth}`, children: [deepestSupported] });
}
const deepestPrefix = "│  │  │  │  ";
const deepestLines = plain(render(details([deepestSupported]), { expanded: true, width: 20 }).body)
	.split("\n")
	.map((line) => line.trimEnd());
for (const line of ["deep", "Activity", "1. x", "Returned", "answer", "Details", "turns 0"]) {
	assert.ok(deepestLines.includes(`${deepestPrefix}${line}`), `deepest expanded ${line} keeps every rail at width 20`);
}
assert.ok(deepestLines.every((line) => visibleWidth(line) <= 20), "deepest expanded tree fits width 20");

// Failed agents can return useful output before the failure. Keep that output
// for every role and tree position, instead of replacing it with the error.
const failedReturnDetails = details([node({
	role: "debugger",
	status: "error",
	error: "verification failed",
	finalText: "root diagnostic output",
	children: [node({
		parentId: 999,
		role: "worker",
		status: "error",
		error: "build failed",
		finalText: "nested implementation output",
	})],
})]);
for (const width of [24, 80]) {
	for (const expandedState of [false, true]) {
		const output = plain(render(failedReturnDetails, { expanded: expandedState, width }).body).replace(/\s+/g, " ");
		for (const expected of ["verification failed", "root diagnostic output", "build failed", "nested implementation output"]) {
			assert.match(output, new RegExp(expected.replaceAll(" ", "\\W+")), `${expandedState ? "expanded" : "compact"} error output includes ${expected} at width ${width}`);
		}
	}
}

// Transcript rows preserve every agent's complete prompt at every lifecycle
// state. Long and explicit multiline prompts wrap instead of being cut off, and
// each terminal answer follows its owning prompt, including for nested agents.
const promptStates: RunNodeStatus[] = ["dormant", "active", "success", "error", "aborted"];
const promptMatrix = details(promptStates.map((status, index) => node({
	status,
	task: `Prompt ${index + 1} first line\nPrompt ${index + 1} second line with enough words to wrap at narrow width`,
	startedAt: status === "dormant" ? undefined : 2,
	finishedAt: status === "active" || status === "dormant" ? undefined : 3,
	finalText: status === "success" ? `OUTPUT ${index + 1}` : undefined,
	error: status === "error" ? `OUTPUT ${index + 1}` : undefined,
})));
for (const expandedState of [false, true]) {
	const rendered = plain(render(promptMatrix, { expanded: expandedState, width: 32 }).body);
	const flattened = flattenRailContent(rendered);
	for (let index = 0; index < promptStates.length; index++) {
		assert.match(flattened, new RegExp(`Prompt ${index + 1} first line Prompt ${index + 1} second line with enough words to wrap at narrow width`));
	}
	for (const index of [2, 3]) {
		assert.ok(rendered.indexOf(`Prompt ${index + 1} first line`) < rendered.indexOf(`OUTPUT ${index + 1}`), "output follows its owning prompt");
	}
}
const nestedPrompt = plain(render(details([node({
	task: "Root prompt has a complete long instruction that must wrap",
	finalText: "ROOT OUTPUT",
	children: [node({
		parentId: 999,
		task: "Nested prompt line one\nNested prompt line two must also remain complete",
		finalText: "NESTED OUTPUT",
	})],
})]), { width: 30 }).body);
assert.match(nestedPrompt.replace(/\s+/g, " "), /Nested prompt line one Nested prompt line two must also remain complete/);
assert.ok(nestedPrompt.indexOf("Nested prompt line one") < nestedPrompt.indexOf("NESTED OUTPUT"));

const nestedStateDetails = details([node({
	task: "Owning root prompt",
	finalText: "OWNING ROOT OUTPUT",
	children: promptStates.map((status, index) => node({
		parentId: 999,
		status,
		task: `Nested ${index + 1} A\nNested ${index + 1} B`,
		startedAt: status === "dormant" ? undefined : 2,
		finishedAt: status === "active" || status === "dormant" ? undefined : 3,
		finalText: status === "success" ? `NESTED OUTPUT ${index + 1}` : undefined,
		error: status === "error" ? `NESTED OUTPUT ${index + 1}` : undefined,
	})),
})]);
for (const expandedState of [false, true]) {
	const rendered = plain(render(nestedStateDetails, { expanded: expandedState, width: 80 }).body);
	const lines = rendered.split("\n");
	for (let index = 0; index < promptStates.length; index++) {
		const firstLine = lines.findIndex((line) => line.includes(`Nested ${index + 1} A`));
		assert.notEqual(firstLine, -1, `nested ${promptStates[index]} prompt starts visibly`);
		assert.ok(lines[firstLine + 1].endsWith(`Nested ${index + 1} B`), "explicit prompt newline is preserved");
	}
	for (const index of [2, 3]) {
		assert.ok(rendered.indexOf(`Nested ${index + 1} A`) < rendered.indexOf(`NESTED OUTPUT ${index + 1}`), "nested output follows its owning prompt");
	}
}

let deepPromptNode = node({ task: "Deep prompt remains fully visible", finalText: "DEEP OUTPUT REMAINS VISIBLE" });
for (let depth = 0; depth < 8; depth++) {
	deepPromptNode = node({ task: `Outer prompt ${depth}`, finalText: `outer output ${depth}`, children: [deepPromptNode] });
}
for (const expandedState of [false, true]) {
	const renderedLines = render(details([deepPromptNode]), { expanded: expandedState, width: 20 }).body;
	const rendered = plain(renderedLines);
	const flattened = flattenRailContent(rendered);
	assert.match(flattened, /Deep prompt remains fully visible/);
	assert.match(flattened, /DEEP OUTPUT REMAINS VISIBLE/);
	assert.ok(flattened.indexOf("Deep prompt") < flattened.indexOf("DEEP OUTPUT"));
	assert.ok(renderedLines.every((line) => visibleWidth(line) <= 20));
}

// Costs are dynamically hidden by default, including expanded metrics, and can be revealed.
const withoutCosts = render(details([node()]), { expanded: true });
assert.doesNotMatch(plain(withoutCosts.body), /\$|own cost|subtree total/);
const compactWithCosts = plain(render(details([node()]), { showCosts: true, width: 24 }).body);
assert.match(compactWithCosts.split("\n")[0], /↑12 ↓8/, "tokens survive before lower-priority cost/tools fields");
const withCosts = plain(render(details([node()]), { expanded: true, showCosts: true }).body);
assert.match(withCosts, /\$0\.0123|own cost/);
assert.doesNotMatch(withCosts, /subtree\s+total/, "leaf cards do not repeat own cost as a subtree total");
const nestedCosts = plain(render(clarityDetails, { expanded: true, showCosts: true }).body);
assert.equal((nestedCosts.match(/subtree\s+total/g) ?? []).length, 2, "only cards with descendants show a distinct subtree total");

// Every status uses the shared two-line grammar and second-resolution active time.
const states = plain(render(details([
	node({ status: "active", durationMs: 29_999 }),
	node({ status: "success", durationMs: 2_999 }),
	node({ status: "error", durationMs: 3_999 }),
	node({ status: "aborted", durationMs: 4_999 }),
	node({ status: "dormant", durationMs: 0, usage: emptyUsage() }),
])).body);
for (const marker of ["● Ada · worker · tinkering · 0:29", "✓ Ada · worker · 0:02", "✗ Ada · worker · error · 0:03", "⊘ Ada · worker · aborted · 0:04", "○ Ada · worker · waiting"]) {
	assert.match(states, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.equal(states.split("\n").filter((line) => /[●✓✗⊘○] Ada/.test(line)).length * 2 <= states.split("\n").length, true);

// Generic delegation activity is suppressed while concrete child activity remains.
const genericParent = node({
	status: "active",
	activity: { type: "tool", at: 3, tool: "subagent", text: "private args" },
	toolLog: ["subagent private args"],
	children: [node({ parentId: 1, status: "active", activity: { type: "tool", at: 3, tool: "git-inspect" } })],
});
const genericText = plain(render(details([genericParent]), { expanded: true }).body);
assert.doesNotMatch(genericText, /subagent|private args/);
assert.match(genericText, /used git-inspect! · Implement a carefully scoped change/);

// Historical nested rows use the same connected sibling grammar instead of
// flattening every descendant into an unrelated final branch.
const legacyTree = plain(render({
	mode: "single",
	rows: [{
		agent: "Root",
		task: "root task",
		children: [
			{ agent: "First", task: "first task" },
			{ agent: "Last", task: "last task" },
		],
	}],
}).body);
assert.match(legacyTree, /✓ Root[^\n]*\n│  root task\n├─ ✓ First[^\n]*\n│     first task\n╰─ ✓ Last[^\n]*\n      last task/);

// Live and final use the same identity/task grammar; final only adds terminal fields and answers.
const sharedNode = node({ status: "active", durationMs: 20_000, activity: { type: "tool", at: 3, tool: "read" } });
const sharedCall = snapshot([sharedNode]);
assert.deepEqual(
	plain(render(details([sharedNode])).body).split("\n").slice(0, 2),
	plain((formatLiveSurface([sharedCall]) ?? "").split("\n").slice(1)).split("\n"),
);

// Configured color wraps status and name; root identities have no connector.
const colored = render(details([node({ color: "purple" })])).body.join("\n");
assert.match(colored, /\x1b\[38;2;186;134;232m✓\x1b\[39m/);
assert.match(colored, /\x1b\[38;2;186;134;232mAda\x1b\[39m/);
assert.match(colored, /\x1b\[38;2;186;134;232mworker\x1b\[39m/, "the role uses the same configured color as the name");
const separatedRole = formatAgentIdentityLine(
	node({ color: "purple" }),
	{ ancestors: [], last: true },
	{ muted: (text) => `<muted>${text}</muted>` },
	80,
);
assert.match(separatedRole, /<muted> · <\/muted>\x1b\[38;2;186;134;232mworker/, "the separator remains muted outside the colored role");
assert.doesNotMatch(colored, /[├└╰]─/);

// Narrow rendering remains bounded even for user-controlled summaries and identities.
const wide = details([node({ persona: { base: "An extremely long child identity", friendDepth: 3 }, finalText: "A very long returned summary ".repeat(20) })]);
for (const width of [20, 40, 80]) {
	for (const line of render(wide, { width }).all) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
}
let deep = node({ task: "deepest task", finalText: "DEEPLY NESTED ANSWER" });
for (let depth = 0; depth < 8; depth++) {
	deep = node({ task: `parent ${depth}`, finalText: `parent answer ${depth}`, children: [deep] });
}
const narrowNestedLines = render(details([deep]), { width: 20 }).all;
assert.match(plain(narrowNestedLines).replace(/\s/g, ""), /DEEPLYNESTEDANSWER/, "deep answers remain visible at narrow widths");
for (const line of narrowNestedLines) assert.ok(visibleWidth(line) <= 20, `${visibleWidth(line)} > 20`);

// Exact JSON is rendered literally rather than interpreted as Markdown.
const exactJsonDetails = details([node({
	finalText: '```json\n{"answer":"**literal** and _unchanged_"}\n```',
	structuredResult: { schemaVersion: 1, view: "exact", kind: "custom", schema: { type: "object", properties: { answer: { type: "string" } } } },
})]);
const exactJson = render(exactJsonDetails);
assert.match(plain(exactJson.body), /\*\*literal\*\* and _unchanged_/, "Exact JSON retains Markdown punctuation");
assert.match(plain(exactJson.body), /shows both structured result views/, "collapsed structured output advertises Pi's configured expansion action");
const expandedExactJson = plain(render(exactJsonDetails, { expanded: true }).body);
assert.ok(expandedExactJson.indexOf("Exact JSON") < expandedExactJson.indexOf("Readable"), "expanded output keeps the persisted preferred view first");
assert.match(expandedExactJson, /collapses structured result views/);

// Stored snapshots still validate defensively and HTML-export's result-owned header remains correct.
const stored = structuredClone(details([node()])) as any;
assert.ok(normalizeV2Details(stored));
stored.call.roots[0].structuredResult = { schemaVersion: 99, view: "broken", schema: null };
const withoutMalformedMetadata = normalizeV2Details(stored);
assert.ok(withoutMalformedMetadata, "malformed optional descriptors do not discard an otherwise valid V2 row");
assert.equal(withoutMalformedMetadata.call.roots[0].structuredResult, undefined);
const descriptorAt = (bytes: number) => {
	const base = { schemaVersion: 1, view: "readable", kind: "custom", schema: { type: "object", properties: { x: { enum: [""] } } } } as any;
	const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
	base.schema.properties.x.enum[0] = "x".repeat(bytes - overhead);
	return base;
};
stored.call.roots[0].structuredResult = descriptorAt(RESULT_CAP_BYTES);
assert.ok(normalizeV2Details(stored)?.call.roots[0].structuredResult, "a descriptor exactly at the cap is retained");
stored.call.roots[0].structuredResult = descriptorAt(RESULT_CAP_BYTES + 1);
assert.equal(normalizeV2Details(stored)?.call.roots[0].structuredResult, undefined, "an over-cap descriptor fails closed without discarding the row");
stored.call.roots[0].usage.cost = "bad";
assert.equal(normalizeV2Details(stored), undefined);
const exportState: SubagentRendererState = {};
const args = { agent: "worker", task: "implement" };
const exportContext: SubagentRendererContext = { args, state: exportState, lastComponent: undefined, executionStarted: true, argsComplete: true, isPartial: true };
assert.deepEqual(renderSubagentCall(args, theme, exportContext).render(80), []);
const exported = renderSubagentResult({ content: [{ type: "text", text: "combined" }], details: details([node()]) }, { expanded: false, isPartial: false }, theme, { ...exportContext, lastComponent: undefined }).render(80);
assert.doesNotMatch(plain(exported), /^calling for help\.\.\.$/m);
assert.match(plain(exported), /Returned/);

console.log("tool renderer unit tests passed");
