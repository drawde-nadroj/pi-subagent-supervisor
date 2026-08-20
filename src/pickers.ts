import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Keymap } from "./keymap.ts";
import { COLOR_HEX, colorize } from "./colors.ts";

/** The tools a subagent can be granted. read/grep/find/ls are read-only. */
export const ALL_TOOLS: Array<{ name: string; note: string }> = [
	{ name: "read", note: "read files (read-only)" },
	{ name: "grep", note: "search file contents (read-only)" },
	{ name: "find", note: "find files by name (read-only)" },
	{ name: "ls", note: "list directories (read-only)" },
	{ name: "bash", note: "run shell commands" },
	{ name: "edit", note: "edit existing files" },
	{ name: "write", note: "create/overwrite files" },
];

/** Tool checklist. Returns the selected tool names, or undefined if cancelled.
 * An empty selection means "inherit pi defaults" (read, bash, edit, write). */
export function pickTools(ctx: ExtensionContext, km: Keymap, current: string[]): Promise<string[] | undefined> {
	return ctx.ui.custom<string[] | undefined>((tui: any, theme: any, kb: any, done: (r: string[] | undefined) => void) => {
		let i = 0;
		let cached: string[] | undefined;
		const sel = new Set(current);
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (km.matches("up", data, kb)) {
				i = (i - 1 + ALL_TOOLS.length) % ALL_TOOLS.length;
				refresh();
				return;
			}
			if (km.matches("down", data, kb)) {
				i = (i + 1) % ALL_TOOLS.length;
				refresh();
				return;
			}
			if (km.matches("toggle", data, kb)) {
				const n = ALL_TOOLS[i].name;
				if (sel.has(n)) sel.delete(n);
				else sel.add(n);
				refresh();
				return;
			}
			if (km.matches("confirm", data, kb)) {
				done(ALL_TOOLS.filter((t) => sel.has(t.name)).map((t) => t.name));
				return;
			}
			if (km.matches("cancel", data, kb)) {
				done(undefined);
				return;
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Tools") + theme.fg("dim", `   ${km.label("up", kb)}/${km.label("down", kb)} move   ${km.label("toggle", kb)} toggle   ${km.label("confirm", kb)} save   ${km.label("cancel", kb)} cancel`));
			add(theme.fg("dim", " (none selected = pi default: read, bash, edit, write)"));
			lines.push("");
			for (let j = 0; j < ALL_TOOLS.length; j++) {
				const t = ALL_TOOLS[j];
				const foc = j === i;
				const box = sel.has(t.name) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const name = foc ? theme.fg("accent", t.name.padEnd(7)) : theme.fg("text", t.name.padEnd(7));
				add(`${foc ? theme.fg("accent", " > ") : "   "}${box} ${name} ${theme.fg("muted", t.note)}`);
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


/** A generic ordered multi-select checklist. Selection order is preserved (toggling
 * an item on appends it), so callers where order is meaningful — e.g. fallback model
 * priority — get a usable result. Returns the selected names in order, or undefined
 * on cancel. Windows the list so a long option set (many models) stays on screen. */
export function pickMulti(
	ctx: ExtensionContext,
	km: Keymap,
	title: string,
	options: Array<{ name: string; note?: string }>,
	current: string[],
	hint?: string,
): Promise<string[] | undefined> {
	return ctx.ui.custom<string[] | undefined>((tui: any, theme: any, kb: any, done: (r: string[] | undefined) => void) => {
		let i = 0;
		let cached: string[] | undefined;
		// Ordered selection: index in this array = the order the item will be emitted in.
		const sel: string[] = current.filter((n) => options.some((o) => o.name === n));
		const MAX_VISIBLE = 12;
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		const toggle = (n: string) => {
			const at = sel.indexOf(n);
			if (at >= 0) sel.splice(at, 1);
			else sel.push(n);
		};
		function handleInput(data: string) {
			if (options.length === 0) {
				if (km.matches("confirm", data, kb) || km.matches("cancel", data, kb)) done(km.matches("confirm", data, kb) ? [] : undefined);
				return;
			}
			if (km.matches("up", data, kb)) {
				i = (i - 1 + options.length) % options.length;
				refresh();
			} else if (km.matches("down", data, kb)) {
				i = (i + 1) % options.length;
				refresh();
			} else if (km.matches("toggle", data, kb)) {
				toggle(options[i].name);
				refresh();
			} else if (km.matches("confirm", data, kb)) {
				done([...sel]);
			} else if (km.matches("cancel", data, kb)) {
				done(undefined);
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", ` ${title}`) + theme.fg("dim", `   ${km.label("up", kb)}/${km.label("down", kb)} move   ${km.label("toggle", kb)} toggle   ${km.label("confirm", kb)} save   ${km.label("cancel", kb)} cancel`));
			if (hint) add(theme.fg("dim", ` ${hint}`));
			lines.push("");
			if (options.length === 0) {
				add(theme.fg("dim", " (no options available)"));
			} else {
				// Scroll window centered on the cursor so long lists stay on screen.
				let start = Math.max(0, Math.min(i - Math.floor(MAX_VISIBLE / 2), options.length - MAX_VISIBLE));
				start = Math.max(0, start);
				const end = Math.min(options.length, start + MAX_VISIBLE);
				if (start > 0) add(theme.fg("dim", `   … ${start} above`));
				const nameW = Math.max(4, ...options.slice(start, end).map((o) => o.name.length));
				for (let j = start; j < end; j++) {
					const o = options[j];
					const foc = j === i;
					const order = sel.indexOf(o.name);
					const box = order >= 0 ? theme.fg("success", `[${order + 1}]`) : theme.fg("dim", "[ ]");
					const name = foc ? theme.fg("accent", o.name.padEnd(nameW)) : theme.fg("text", o.name.padEnd(nameW));
					add(`${foc ? theme.fg("accent", " > ") : "   "}${box} ${name}${o.note ? ` ${theme.fg("muted", o.note)}` : ""}`);
				}
				if (end < options.length) add(theme.fg("dim", `   … ${options.length - end} below`));
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

/** Standalone swatch color picker overlay. Returns the chosen color name, or
 * undefined if cancelled. */
export function pickColor(ctx: ExtensionContext, km: Keymap, current: string): Promise<string | undefined> {
	const colors = Object.keys(COLOR_HEX);
	return ctx.ui.custom<string | undefined>((tui: any, theme: any, kb: any, done: (r: string | undefined) => void) => {
		let i = Math.max(0, colors.indexOf(current));
		let cached: string[] | undefined;
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		function handleInput(data: string) {
			if (km.matches("left", data, kb) || km.matches("up", data, kb)) {
				i = (i - 1 + colors.length) % colors.length;
				refresh();
				return;
			}
			if (km.matches("right", data, kb) || km.matches("down", data, kb)) {
				i = (i + 1) % colors.length;
				refresh();
				return;
			}
			if (km.matches("confirm", data, kb)) {
				done(colors[i]);
				return;
			}
			if (km.matches("cancel", data, kb)) {
				done(undefined);
				return;
			}
		}
		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Pick a color") + theme.fg("muted", `   ${km.label("left", kb)}/${km.label("right", kb)} move   ${km.label("confirm", kb)} choose   ${km.label("cancel", kb)} cancel`));
			lines.push("");
			const swatches = colors.map((c, j) => (j === i ? `[${colorize(c, "●")}]` : ` ${colorize(c, "●")} `)).join("");
			add(` ${swatches}`);
			add(`   ${theme.fg("accent", colorize(colors[i], "●"))} ${theme.fg("text", colors[i])}`);
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
