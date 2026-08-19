import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { SubagentState } from "./state.ts";

export type Action =
	| "up"
	| "down"
	| "left"
	| "right"
	| "toggle"
	| "confirm"
	| "cancel"
	| "edit"
	| "new"
	| "delete"
	| "settings"
	| "suggest"
	| "open";

/** Display order + human labels for the settings page. */
export const ACTIONS: Array<{ action: Action; label: string }> = [
	{ action: "up", label: "Move up" },
	{ action: "down", label: "Move down" },
	{ action: "left", label: "Adjust / previous" },
	{ action: "right", label: "Adjust / next" },
	{ action: "toggle", label: "Toggle" },
	{ action: "edit", label: "Edit" },
	{ action: "new", label: "New agent" },
	{ action: "delete", label: "Delete" },
	{ action: "open", label: "Open .md in OS editor" },
	{ action: "suggest", label: "AI suggestion" },
	{ action: "settings", label: "Open settings" },
	{ action: "confirm", label: "Confirm" },
	{ action: "cancel", label: "Cancel" },
];

export const DEFAULT_KEYS: Record<Action, string> = {
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	toggle: "space",
	confirm: "enter",
	cancel: "escape",
	edit: "e",
	new: "n",
	delete: "d",
	settings: ",",
	suggest: "tab",
	open: "o",
};

const SPECIAL: Record<string, string> = {
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	enter: "enter",
	escape: "escape",
	space: "space",
	tab: "tab",
};
const SPECIAL_KEY: Record<string, any> = {
	up: Key.up,
	down: Key.down,
	left: Key.left,
	right: Key.right,
	enter: Key.enter,
	escape: Key.escape,
	space: Key.space,
	tab: Key.tab,
};

export function keyIdMatches(keyId: string, data: string): boolean {
	if (Object.hasOwn(SPECIAL_KEY, keyId)) return matchesKey(data, SPECIAL_KEY[keyId]);
	return data === keyId;
}

/** Convert a raw input chunk into a stable key id, or null if unsupported. */
export function dataToKeyId(data: string): string | null {
	for (const id of Object.keys(SPECIAL)) if (matchesKey(data, SPECIAL_KEY[id])) return id;
	if (data.length === 1 && data >= " " && data <= "~") return data;
	return null;
}

export function keyLabel(keyId: string): string {
	const map: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", enter: "⏎", escape: "esc", space: "space", tab: "Tab" };
	return map[keyId] ?? (keyId === " " ? "space" : keyId);
}

/** Reads keybind overrides from SubagentState (defaults when unset) and matches input. */
export class Keymap {
	private state: SubagentState;

	constructor(state: SubagentState) {
		this.state = state;
	}
	key(action: Action): string {
		return this.state.getKeybinds()[action] ?? DEFAULT_KEYS[action];
	}
	matches(action: Action, data: string): boolean {
		return keyIdMatches(this.key(action), data);
	}
	label(action: Action): string {
		return keyLabel(this.key(action));
	}
	/** Rebind from a raw input chunk. Returns false if the key is unsupported. */
	rebind(action: Action, data: string): boolean {
		const id = dataToKeyId(data);
		if (!id) return false;
		this.state.setKeybind(action, id);
		return true;
	}
}
