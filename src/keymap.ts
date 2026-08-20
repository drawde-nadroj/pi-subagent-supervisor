import { Key, matchesKey, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { SubagentState } from "./state.ts";

export type Action = "up" | "down" | "left" | "right" | "toggle" | "confirm" | "cancel" | "edit" | "contract" | "preview" | "new" | "delete" | "settings" | "suggest" | "open" | "help" | "back" | "reorderUp" | "reorderDown";
type LegacyAction = Exclude<Action, "contract" | "preview" | "help" | "back" | "reorderUp" | "reorderDown">;

export const DEFAULT_KEYS: Record<Action, string> = {
	up: "up", down: "down", left: "left", right: "right", toggle: "space",
	confirm: "enter", cancel: "escape", edit: "e", contract: "c", preview: "p", new: "n", delete: "d",
	settings: ",", suggest: "tab", open: "o", help: "?", back: "b", reorderUp: "[", reorderDown: "]",
};

const STANDARD: Partial<Record<Action,
	"tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel" |
	"tui.editor.cursorLeft" | "tui.editor.cursorRight" | "tui.input.tab">> = {
	up: "tui.select.up",
	down: "tui.select.down",
	left: "tui.editor.cursorLeft",
	right: "tui.editor.cursorRight",
	confirm: "tui.select.confirm",
	cancel: "tui.select.cancel",
	suggest: "tui.input.tab",
};

const PACKAGE = new Set<Action>(["toggle", "edit", "contract", "preview", "new", "delete", "settings", "open", "help", "back", "reorderUp", "reorderDown"]);
const SPECIAL_KEY: Record<string, any> = {
	up: Key.up, down: Key.down, left: Key.left, right: Key.right,
	enter: Key.enter, escape: Key.escape, space: Key.space, tab: Key.tab,
};

export function keyIdMatches(keyId: string, data: string): boolean {
	return Object.hasOwn(SPECIAL_KEY, keyId) ? matchesKey(data, SPECIAL_KEY[keyId]) : data === keyId;
}

/** Retained for one-release compatibility with legacy state values. */
export function dataToKeyId(data: string): string | null {
	for (const id of Object.keys(SPECIAL_KEY)) if (matchesKey(data, SPECIAL_KEY[id])) return id;
	if (data.length === 1 && data >= " " && data <= "~") return data;
	return null;
}

export function keyLabel(keyId: string): string {
	return ({ up: "↑", down: "↓", left: "←", right: "→", enter: "⏎", escape: "esc", space: "space", tab: "Tab" } as Record<string, string>)[keyId] ?? keyId;
}

function rawUserKeys(manager: KeybindingsManager, action: Action): string[] | undefined {
	if (!PACKAGE.has(action)) return undefined;
	const id = `pi-subagent-supervisor.${action}`;
	const bindings = manager.getUserBindings() as Record<string, unknown>;
	if (!Object.hasOwn(bindings, id)) return undefined;
	const value = bindings[id];
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((key): key is string => typeof key === "string");
	return [];
}

/**
 * Resolves focused controls without reading Pi configuration from disk.
 * Standard controls use an explicit Pi user binding (including []), legacy
 * state override, then the injected Pi default. Package controls use the same
 * precedence with their package binding and package default.
 */
export class Keymap {
	private readonly state: SubagentState;

	constructor(state: SubagentState) {
		this.state = state;
	}

	key(action: LegacyAction): string {
		return this.state.getKeybinds()[action] ?? DEFAULT_KEYS[action];
	}

	matches(action: Action, data: string, manager?: KeybindingsManager): boolean {
		if (manager) {
			const userKeys = rawUserKeys(manager, action);
			if (userKeys !== undefined) return userKeys.some((key) => matchesKey(data, key as any));
		}
		const standard = STANDARD[action];
		const legacy = this.state.getKeybinds()[action as LegacyAction];
		if (standard && manager) {
			const bindings = manager.getUserBindings() as Record<string, unknown>;
			if (Object.hasOwn(bindings, standard)) return manager.matches(data, standard);
			if (legacy !== undefined) return keyIdMatches(legacy, data);
			return manager.matches(data, standard);
		}
		if (legacy !== undefined) return keyIdMatches(legacy, data);
		return keyIdMatches(DEFAULT_KEYS[action], data);
	}

	label(action: Action, manager?: KeybindingsManager): string {
		if (manager) {
			const userKeys = rawUserKeys(manager, action);
			if (userKeys !== undefined) return userKeys.map(keyLabel).join("/") || "unbound";
		}
		const standard = STANDARD[action];
		const legacy = this.state.getKeybinds()[action as LegacyAction];
		if (standard && manager) {
			const bindings = manager.getUserBindings() as Record<string, unknown>;
			if (Object.hasOwn(bindings, standard)) return manager.getKeys(standard).map(keyLabel).join("/") || "unbound";
			if (legacy !== undefined) return keyLabel(legacy);
			return manager.getKeys(standard).map(keyLabel).join("/") || "unbound";
		}
		if (legacy !== undefined) return keyLabel(legacy);
		return keyLabel(DEFAULT_KEYS[action]);
	}
}
