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
	/** Reveal routine subagent prices in UI surfaces. History is always priced. */
	private showCosts = false;
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
			if (typeof data.showCosts === "boolean") this.showCosts = data.showCosts;
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

	// --- costs ---
	getShowCosts(): boolean {
		return this.showCosts;
	}
	setShowCosts(on: boolean): void {
		this.showCosts = on;
		this.save();
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
	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
			fs.writeFileSync(this.file, JSON.stringify({ keybinds: this.keybinds, structuredReturns: this.structuredReturns, showCosts: this.showCosts }, null, 2), { encoding: "utf-8", mode: 0o600 });
			fs.chmodSync(this.file, 0o600);
		} catch {
			/* best-effort */
		}
	}
}
