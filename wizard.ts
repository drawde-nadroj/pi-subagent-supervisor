import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { writeAgentFile } from "./agent-writer.ts";
import { runAgent } from "./engine.ts";
import { pickColor } from "./pickers.ts";

function editorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

interface Answers {
	name: string;
	displayName: string;
	description: string;
	systemPrompt: string;
}

interface Step {
	key: keyof Answers;
	question: string;
	help?: string[];
	suggest: boolean;
	aiInstruction?: (a: Answers) => string;
}

const STEPS: Step[] = [
	{ key: "name", question: "What do you want this subagent to be called?", suggest: false },
	{ key: "displayName", question: "Optional: what human-facing display name should it use?", suggest: false },
	{
		key: "description",
		question: "What's this agent for? When's it supposed to be called?",
		suggest: true,
		aiInstruction: (a) =>
			`Write a single-line "when to delegate" description for a subagent named "${a.name}", using "use proactively"/"always use for" cues so a parent AI knows when to call it. Output only the line.`,
	},
	{
		key: "systemPrompt",
		question: "What's the system prompt that defines this agent's behavior?",
		help: [
			"Good prompts cover:",
			"  Role   — What is the agent? (e.g. \"you are a fast reconnaissance agent\")",
			"  Rules  — How should it behave? What tools can/can't it use?",
			"  Output — How should it format its results?",
		],
		suggest: true,
		aiInstruction: (a) =>
			`Write a concise system prompt for a subagent named "${a.name}" described as: ${a.description}. Cover its role, a few clear rules (including tool use), and how it should format its final output. Output only the prompt.`,
	},
];

/** Runs the multi-step new-agent overlay. Returns the answers, or null if cancelled. */
function runWizardOverlay(ctx: ExtensionContext): Promise<Answers | null> {
	return ctx.ui.custom<Answers | null>((tui: any, theme: any, _kb: any, done: (r: Answers | null) => void) => {
		const answers: Answers = { name: "", displayName: "", description: "", systemPrompt: "" };
		let step = 0;
		let cached: string[] | undefined;
		let thinking = false;
		let aiAbort: AbortController | null = null;
		let editor = new Editor(tui, editorTheme(theme));

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		function newEditor(prefill = "") {
			editor = new Editor(tui, editorTheme(theme));
			editor.setText(prefill);
			editor.onSubmit = (value: string) => submit(value);
		}
		editor.onSubmit = (value: string) => submit(value);

		function submit(value: string) {
			if (thinking) return;
			const s = STEPS[step];
			const text = value.trim();
			if (s.key === "name" && !text) return; // name required
			answers[s.key] = value;
			if (step >= STEPS.length - 1) {
				done(answers);
				return;
			}
			step += 1;
			newEditor("");
			refresh();
		}

		function startSuggestion() {
			const s = STEPS[step];
			if (!s.suggest || !s.aiInstruction || thinking) return;
			thinking = true;
			aiAbort = new AbortController();
			refresh();
			void (async () => {
				try {
					const handle = await runAgent({
						agent: {
							name: "drafter", description: "drafter", model: "deepseek-v4-pro", thinking: "high",
							fallback: [], auto: true,
							tools: undefined, readonly: true, color: "purple", conventions: false, spawn: [],
							systemPrompt: "You draft a single piece of text exactly as instructed. Output ONLY the requested text — no preamble, no fences.",
							source: "user", filePath: "",
						},
						task: s.aiInstruction!(answers),
						parentModel: ctx.model,
						registry: ctx.modelRegistry,
						cwd: ctx.cwd,
						conventions: false,
						signal: aiAbort!.signal,
						onEvent: () => {},
					});
					const r = await handle.promise;
					if (!thinking) return; // cancelled
					thinking = false;
					aiAbort = null;
					if (r.ok && r.finalText.trim()) newEditor(r.finalText.trim().replace(/^```[a-z]*\n/i, "").replace(/\n```$/i, "").trim());
					refresh();
				} catch {
					thinking = false;
					aiAbort = null;
					refresh();
				}
			})();
		}

		function cancelSuggestion() {
			if (!thinking) return;
			thinking = false;
			aiAbort?.abort();
			aiAbort = null;
			refresh();
		}

		function handleInput(data: string) {
			if (thinking) {
				if (matchesKey(data, Key.escape)) cancelSuggestion();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				if (step === 0) {
					done(null);
					return;
				}
				step -= 1;
				newEditor(answers[STEPS[step].key]);
				refresh();
				return;
			}
			if (STEPS[step].suggest && matchesKey(data, Key.tab)) {
				startSuggestion();
				return;
			}
			editor.handleInput(data);
			refresh();
		}

		function build(width: number): string[] {
			const s = STEPS[step];
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Create a new subagent") + theme.fg("dim", `   step ${step + 1}/${STEPS.length}`));
			lines.push("");
			for (const w of wrapTextWithAnsi(theme.fg("text", s.question), width - 1)) add(` ${w}`);
			if (s.help) for (const h of s.help) add(theme.fg("dim", ` ${h}`));
			lines.push("");
			// running summary of prior answers, each labelled by its field
			const LABELS: Record<keyof Answers, string> = { name: "Name", displayName: "Display Name", description: "Description", systemPrompt: "System Prompt" };
			for (let k = 0; k < step; k++) {
				const key = STEPS[k].key;
				if (answers[key]) {
					const label = LABELS[key];
					add(theme.fg("muted", ` ${label}: `) + theme.fg("dim", answers[key].replace(/\s+/g, " ").slice(0, Math.max(1, width - label.length - 4))));
				}
			}
			lines.push("");
			if (thinking) {
				add(theme.fg("accent", " Thinking super duper hard...") + theme.fg("dim", "   (esc to cancel)"));
			} else {
				for (const l of editor.render(Math.max(1, width - 2))) add(` ${l}`);
				lines.push("");
				if (s.suggest) add(theme.fg("muted", " [Tab] ") + theme.fg("accent", "Want a suggestion?"));
				add(theme.fg("dim", " ⏎ submit"));
				add(theme.fg("dim", " esc " + (step === 0 ? "cancel" : "back")));
			}
			add(theme.fg("accent", "─".repeat(width)));
			return lines;
		}

		return {
			render(width: number) {
				if (cached) return cached;
				cached = build(width);
				return cached;
			},
			invalidate() {
				cached = undefined;
			},
			handleInput,
		};
	});
}

export async function newAgentWizard(ctx: ExtensionContext): Promise<void> {
	const answers = await runWizardOverlay(ctx);
	if (!answers || !answers.name.trim()) return;
	const color = await pickColor(ctx, "cyan");
	if (!color) return;
	const dir = path.join(getAgentDir(), "agents");
	const file = writeAgentFile(
		{
			name: answers.name.trim(),
			displayName: answers.displayName.trim() || undefined,
			description: answers.description.trim() || answers.name.trim(),
			fallback: [],
			auto: true,
			color,
			readonly: false,
			conventions: false,
			spawn: [],
			systemPrompt: answers.systemPrompt.trim(),
			tools: undefined,
		},
		dir,
	);
	ctx.ui.notify(`Created "${answers.name.trim()}" → ${file}. Run /reload to use /${path.basename(file, ".md")}.`, "info");
}
