import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultStatePath } from "./storage.ts";

export { getDefaultStatePath } from "./storage.ts";

/** Persistent state: keybind overrides. Stored in state.json.
 * Routing lives entirely in agent frontmatter (`auto: true|false`) — the old
 * active toggles / groups / global advertiseAll were collapsed into that. */
export class SubagentState {
	private keybinds: Record<string, string> = {};
	/** Enforce agents' `returns:` schemas (instruction + validation + repair turn). */
	private structuredReturns = true;
	private resultView: import("./result-view.ts").ResultView = "readable";
	/** Reveal routine subagent prices in UI surfaces. History is always priced. */
	private showCosts = false;
	/** Persist completed-run history for stats. Defaults on for compatibility. */
	private historyEnabled = true;
	/** Prompt material is sensitive and is never captured unless explicitly enabled. */
	private promptCaptureEnabled = false;
	private listeners = new Set<() => void>();
	private file: string;

	constructor(file: string = getDefaultStatePath()) {
		this.file = file;
		try {
			const data = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (data.keybinds && typeof data.keybinds === "object") {
				for (const [k, v] of Object.entries(data.keybinds)) if (typeof v === "string") this.keybinds[k] = v;
			}
			if (typeof data.structuredReturns === "boolean") this.structuredReturns = data.structuredReturns;
			if (data.resultView === "readable" || data.resultView === "exact") this.resultView = data.resultView;
			if (typeof data.showCosts === "boolean") this.showCosts = data.showCosts;
			if (typeof data.historyEnabled === "boolean") this.historyEnabled = data.historyEnabled;
			if (typeof data.promptCaptureEnabled === "boolean") this.promptCaptureEnabled = data.promptCaptureEnabled;
		} catch {
			/* no state yet */
		}
	}

	// --- structured returns toggle ---
	getStructuredReturns(): boolean {
		return this.structuredReturns;
	}
	setStructuredReturns(on: boolean): void {
		this.structuredReturns = on;
		this.save();
		this.notify();
	}

	getResultView(): import("./result-view.ts").ResultView { return this.resultView; }
	setResultView(view: import("./result-view.ts").ResultView): void {
		const previous = this.resultView;
		this.resultView = view;
		const error = this.save();
		if (error) {
			this.resultView = previous;
			throw error;
		}
		this.notify();
	}

	// --- costs ---
	getShowCosts(): boolean {
		return this.showCosts;
	}
	setShowCosts(on: boolean): void {
		this.showCosts = on;
		this.save();
		this.notify();
	}

	// --- run history ---
	getHistoryEnabled(): boolean {
		return this.historyEnabled;
	}
	setHistoryEnabled(on: boolean): void {
		const previous = this.historyEnabled;
		this.historyEnabled = on;
		const error = this.save();
		if (error) {
			this.historyEnabled = previous;
			throw error;
		}
		this.notify();
	}

	getPromptCaptureEnabled(): boolean { return this.promptCaptureEnabled; }
	setPromptCaptureEnabled(on: boolean): void {
		const previous = this.promptCaptureEnabled;
		this.promptCaptureEnabled = on;
		const error = this.save();
		if (error) { this.promptCaptureEnabled = previous; throw error; }
		this.notify();
	}

	// --- keybinds ---
	getKeybinds(): Record<string, string> {
		return { ...this.keybinds };
	}
	setKeybind(action: string, keyId: string): void {
		this.keybinds[action] = keyId;
		this.save();
		this.notify();
	}
	resetKeybinds(): void {
		this.keybinds = {};
		this.save();
		this.notify();
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private notify(): void {
		for (const cb of this.listeners) cb();
	}
	private save(): Error | undefined {
		const directory = path.dirname(this.file);
		const temporary = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${Date.now()}.tmp`);
		try {
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			fs.chmodSync(directory, 0o700);
			fs.writeFileSync(temporary, JSON.stringify({ keybinds: this.keybinds, structuredReturns: this.structuredReturns, ...(this.resultView === "readable" ? {} : { resultView: this.resultView }), showCosts: this.showCosts, historyEnabled: this.historyEnabled, promptCaptureEnabled: this.promptCaptureEnabled }, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
			fs.chmodSync(temporary, 0o600);
			fs.renameSync(temporary, this.file);
			return undefined;
		} catch (error) {
			try {
				fs.unlinkSync(temporary);
			} catch {
				/* no temporary file to clean up */
			}
			return error instanceof Error ? error : new Error(String(error));
		}
	}
}
