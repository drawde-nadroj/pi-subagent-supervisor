import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { ACTIONS, DEFAULT_KEYS, keyLabel, type Keymap } from "./keymap.ts";
import type { SubagentState } from "./state.ts";

/** Preferences landing page. Keybindings remain in their focused editor. */
export async function showPreferences(ctx: ExtensionContext, km: Keymap, state: SubagentState): Promise<void> {
	while (true) {
		const openKeys = await ctx.ui.custom<boolean>((tui: any, theme: any, _kb: any, done: (r: boolean) => void) => {
			let index = 0;
			let cached: string[] | undefined;
			const refresh = () => { cached = undefined; tui.requestRender(); };
			const handleInput = (data: string) => {
				if (matchesKey(data, Key.escape)) return done(false);
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) { index = matchesKey(data, Key.up) ? Math.max(0, index - 1) : Math.min(3, index + 1); refresh(); return; }
				if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.enter)) {
					if (index === 0) { state.setShowCosts(!state.getShowCosts()); refresh(); }
					else if (index === 1) {
						try {
							state.setResultView(state.getResultView() === "readable" ? "exact" : "readable");
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						}
						refresh();
					}
					else if (index === 2) {
						try { state.setPromptCaptureEnabled(!state.getPromptCaptureEnabled()); }
						catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
						refresh();
					}
					else done(true);
				}
			};
			const build = (width: number): string[] => {
				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));
				add(theme.fg("accent", "─".repeat(width)));
				add(theme.fg("text", " Preferences") + theme.fg("dim", "   ↑↓ move   ←→/⏎ change   esc close"));
				lines.push("");
				const row = (at: number, label: string, value: string) => add(`${index === at ? theme.fg("accent", " > ") : "   "}${theme.fg(index === at ? "accent" : "text", label)} ${theme.fg("dim", value)}`);
				row(0, "Show costs", state.getShowCosts() ? "on" : "off");
				row(1, "Structured results", state.getResultView());
				row(2, "Effective prompt capture", state.getPromptCaptureEnabled() ? "on — persists in Pi session" : "off — opt-in session storage");
				row(3, "Keybindings…", "");
				add(theme.fg("accent", "─".repeat(width)));
				return lines;
			};
			return { render: (width: number) => (cached ??= build(width)), invalidate: () => { cached = undefined; }, handleInput };
		});
		if (!openKeys) return;
		await showKeybindSettings(ctx, km, state);
	}
}

/** Keybind settings overlay. Navigation here is FIXED (↑↓ / enter / esc / r) and
 * NOT remappable, so a bad rebind can never lock you out. */
export function showKeybindSettings(ctx: ExtensionContext, km: Keymap, state: SubagentState): Promise<void> {
	return ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: (r: void) => void) => {
		let i = 0;
		let capturing = false;
		let cached: string[] | undefined;
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (capturing) {
				if (matchesKey(data, Key.escape)) {
					capturing = false;
					refresh();
					return;
				}
				const ok = km.rebind(ACTIONS[i].action, data);
				if (!ok) ctx.ui.notify("Unsupported key — try another.", "warning");
				capturing = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				i = Math.max(0, i - 1);
				refresh();
			} else if (matchesKey(data, Key.down)) {
				i = Math.min(ACTIONS.length - 1, i + 1);
				refresh();
			} else if (matchesKey(data, Key.enter)) {
				capturing = true;
				refresh();
			} else if (data === "r") {
				state.resetKeybinds();
				refresh();
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Keybind settings") + theme.fg("dim", "   ↑↓ move · ⏎ rebind · r reset all · esc close"));
			add(theme.fg("dim", " (these nav keys are fixed so you can't lock yourself out)"));
			lines.push("");
			for (let j = 0; j < ACTIONS.length; j++) {
				const a = ACTIONS[j];
				const foc = j === i;
				const cur = km.label(a.action);
				const isDefault = (state.getKeybinds()[a.action] ?? DEFAULT_KEYS[a.action]) === DEFAULT_KEYS[a.action];
				const keyCol = foc && capturing ? theme.fg("warning", "press a key…") : theme.fg("accent", cur);
				const def = isDefault ? "" : theme.fg("dim", `  (default ${keyLabel(DEFAULT_KEYS[a.action])})`);
				add(`${foc ? theme.fg("accent", " > ") : "   "}${theme.fg(foc ? "accent" : "text", a.label.padEnd(20))} ${keyCol}${def}`);
			}
			add(theme.fg("accent", "─".repeat(width)));
			return lines;
		}
		return {
			render: (w: number) => (cached ??= build(w)),
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}
