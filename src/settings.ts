import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Keymap } from "./keymap.ts";
import type { SubagentState } from "./state.ts";

/** Preferences are editable here; keybindings are configured in Pi's user file. */
export async function showPreferences(ctx: ExtensionContext, km: Keymap, state: SubagentState): Promise<void> {
	await ctx.ui.custom<void>((tui: any, theme: any, kb: any, done: (r: void) => void) => {
		let index = 0;
		let cached: string[] | undefined;
		const refresh = () => { cached = undefined; tui.requestRender(); };
		const handleInput = (data: string) => {
			if (km.matches("cancel", data, kb)) return done(undefined);
			if (km.matches("up", data, kb) || km.matches("down", data, kb)) { index = km.matches("up", data, kb) ? Math.max(0, index - 1) : Math.min(3, index + 1); refresh(); return; }
			if (!km.matches("confirm", data, kb)) return;
			if (index === 0) state.setShowCosts(!state.getShowCosts());
			else if (index === 1) { try { state.setResultView(state.getResultView() === "readable" ? "exact" : "readable"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } }
			else if (index === 2) { try { state.setPromptCaptureEnabled(!state.getPromptCaptureEnabled()); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } }
			else ctx.ui.notify("Edit ~/.pi/agent/keybindings.json, then run /reload.", "info");
			refresh();
		};
		const build = (width: number): string[] => {
			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Preferences") + theme.fg("dim", `   ${km.label("up", kb)}/${km.label("down", kb)} move   ${km.label("confirm", kb)} change   ${km.label("cancel", kb)} close`));
			lines.push("");
			const row = (at: number, label: string, value: string) => add(`${index === at ? theme.fg("accent", " > ") : "   "}${theme.fg(index === at ? "accent" : "text", label)} ${theme.fg("dim", value)}`);
			row(0, "Show costs", state.getShowCosts() ? "on" : "off");
			row(1, "Structured results", state.getResultView());
			row(2, "Effective prompt capture", state.getPromptCaptureEnabled() ? "on — persists in Pi session" : "off — opt-in session storage");
			row(3, "Keybindings", "~/.pi/agent/keybindings.json (run /reload)");
			add(theme.fg("accent", "─".repeat(width)));
			return lines;
		};
		return { render: (width: number) => (cached ??= build(width)), invalidate: () => { cached = undefined; }, handleInput };
	});
}
