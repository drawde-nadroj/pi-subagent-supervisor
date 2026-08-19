import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { agentMutationRefusal, materializeUserOverride, renameUserAgentFile, updateAgentFile } from "./agent-writer.ts";
import { COLOR_HEX, colorize } from "./colors.ts";
import { pickMulti, pickTools } from "./pickers.ts";
import type { ReturnsSchema } from "./returns.ts";
import { TwoPressConfirmation } from "./two-press-confirmation.ts";

const THINKING = ["", "minimal", "low", "medium", "high", "xhigh"];
const BASIC_FIELDS = ["name", "displayName", "color", "description", "systemPrompt"] as const;
const ADVANCED_FIELDS = ["model", "fallback", "thinking", "tools", "spawn", "returns", "conventions"] as const;
const FIELDS = [...BASIC_FIELDS, ...ADVANCED_FIELDS] as const;
type FieldKey = (typeof FIELDS)[number];
/** Fields edited in a sub-overlay (picker or text editor) rather than inline with ←→. */
type TextField = "name" | "displayName" | "tools" | "spawn" | "fallback" | "returns" | "description" | "systemPrompt";

interface Draft {
	name: string;
	displayName: string;
	model: string;
	/** Comma-joined backup model ids, in priority order. */
	fallback: string;
	auto: boolean;
	thinking: string;
	readonly: boolean;
	conventions: boolean;
	color: string;
	tools: string;
	/** Comma-joined agent names this agent may delegate to. */
	spawn: string;
	/** Raw JSON of the returns schema ("" = none). Validated on save. */
	returns: string;
	description: string;
	systemPrompt: string;
}

type EditorExit =
	| { action: "save"; draft: Draft }
	| { action: "cancel" }
	| { action: "editText"; field: TextField; draft: Draft; focus: number; page: "basic" | "advanced" };

function showEditorOverlay(ctx: ExtensionContext, agentName: string, draft: Draft, models: string[], startFocus: number, startPage: "basic" | "advanced"): Promise<EditorExit> {
	const colors = Object.keys(COLOR_HEX);
	const LABELS: Record<FieldKey, string> = {
		name: "Role / command",
		displayName: "Display name",
		model: "Model",
		fallback: "Fallback",
		auto: "Auto",
		thinking: "Thinking",
		readonly: "Read-only",
		color: "Color",
		tools: "Tool access",
		spawn: "May delegate to",
		returns: "Output schema",
		description: "When to delegate",
		systemPrompt: "Agent instructions",
		conventions: "Project conventions",
	};

	return ctx.ui.custom<EditorExit>((tui: any, theme: any, _kb: any, done: (r: EditorExit) => void) => {
		let page: "basic" | "advanced" = startPage;
		let focus = Math.max(0, Math.min(startFocus, (page === "basic" ? BASIC_FIELDS : ADVANCED_FIELDS).length - 1));
		const fields = () => page === "basic" ? BASIC_FIELDS : ADVANCED_FIELDS;
		const confirmation = new TwoPressConfirmation({
			isConfirm: (data) => matchesKey(data, Key.enter),
			isCancel: (data) => matchesKey(data, Key.escape),
		});
		let cached: string[] | undefined;
		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		function edit(field: FieldKey, dir: number) {
			if (field === "model") {
				const opts = ["", ...models];
				const i = opts.indexOf(draft.model);
				draft.model = opts[(i + dir + opts.length) % opts.length];
			} else if (field === "thinking") {
				const i = THINKING.indexOf(draft.thinking);
				draft.thinking = THINKING[(i + dir + THINKING.length) % THINKING.length];
			} else if (field === "color") {
				const i = colors.indexOf(draft.color);
				draft.color = colors[(i + dir + colors.length) % colors.length];
			} else if (field === "conventions") {
				draft.conventions = !draft.conventions;
			} else {
				// Sub-overlay fields: name / displayName / tools / spawn / fallback / returns / description / systemPrompt.
				done({ action: "editText", field: field as TextField, draft, focus, page });
				return;
			}
			refresh();
		}

		function handleInput(data: string) {
			const confirmationResult = confirmation.handle(data);
			if (confirmationResult.kind === "commit") return done(confirmationResult.action === "confirm" ? { action: "save", draft } : { action: "cancel" });
			if (confirmationResult.kind === "arm") return refresh();
			const field = fields()[focus];
			if (matchesKey(data, Key.tab)) {
				page = page === "basic" ? "advanced" : "basic";
				focus = 0;
				refresh();
			} else if (matchesKey(data, Key.up)) {
				focus = Math.max(0, focus - 1);
				refresh();
			} else if (matchesKey(data, Key.down)) {
				focus = Math.min(fields().length - 1, focus + 1);
				refresh();
			} else if (matchesKey(data, Key.left)) {
				edit(field, -1);
			} else if (matchesKey(data, Key.right)) {
				edit(field, 1);
			} else {
				refresh();
			}
		}

		function build(width: number): string[] {
			const bc = confirmation.borderColor();
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg(bc, "─".repeat(width)));
			if (confirmation.armed === "confirm") add(theme.fg("success", theme.bold(" ✓ Saved!")) + theme.fg("dim", "   ⏎ again to confirm · any key to keep editing"));
			else if (confirmation.armed === "cancel") add(theme.fg("error", theme.bold(" ✗ Canceled!")) + theme.fg("dim", "   esc again to discard · any key to keep editing"));
			else add(theme.fg("text", ` Agent Editor · ${page === "basic" ? "Basic" : "Advanced"}`) + theme.fg("muted", `  ·  ${agentName}`));
			add(theme.fg("dim", " ↑↓ field   ←→ edit   tab Basic/Advanced   ⏎ save   esc cancel"));
			lines.push("");
			for (let i = 0; i < fields().length; i++) {
				const f = fields()[i];
				const foc = i === focus;
				// Long text fields render as full sections (shown once, never cut off).
				if (f === "description" || f === "systemPrompt") {
					const body = f === "description" ? draft.description : draft.systemPrompt;
					const maxLines = f === "systemPrompt" ? 14 : 6;
					lines.push("");
					add(`${foc ? theme.fg("accent", "> ") : "  "}${theme.fg(foc ? "accent" : "text", theme.bold(LABELS[f]))} ${theme.fg("dim", "(←→ to edit — multi-line, paste OK)")}`);
					const wrapped = wrapTextWithAnsi(theme.fg(foc ? "text" : "dim", body || "(empty)"), Math.max(1, width - 5));
					for (const w of wrapped.slice(0, maxLines)) add(`    ${w}`);
					if (wrapped.length > maxLines) add(theme.fg("dim", `    … +${wrapped.length - maxLines} more lines`));
					continue;
				}
				let val = "";
				if (f === "name") val = draft.name ? theme.fg("text", draft.name) : theme.fg("warning", "(unnamed — durable identity)");
				else if (f === "displayName") val = draft.displayName ? theme.fg("text", draft.displayName) : theme.fg("dim", "(optional human-facing name)");
				else if (f === "model") val = draft.model || theme.fg("dim", "(inherit parent)");
				else if (f === "fallback") val = draft.fallback ? theme.fg("muted", draft.fallback) : theme.fg("dim", "(none — no backup models)");
				else if (f === "thinking") val = draft.thinking || theme.fg("dim", "(inherit)");
				else if (f === "color") val = `${colorize(draft.color, "●")} ${draft.color}`;
				else if (f === "spawn") val = draft.spawn ? theme.fg("muted", draft.spawn) : theme.fg("dim", "(none — cannot delegate)");
				else if (f === "returns") val = draft.returns.trim() ? theme.fg("muted", truncateToWidth(draft.returns.replace(/\s+/g, " "), Math.max(12, width - 20))) : theme.fg("dim", "(none)");
				else if (f === "conventions") val = draft.conventions ? theme.fg("success", "on") : theme.fg("dim", "off");
				else val = draft.tools ? theme.fg("muted", `${draft.readonly ? "read-only custom: " : "custom: "}${draft.tools}`) : draft.readonly ? theme.fg("success", "read-only defaults") : theme.fg("dim", "default");
				add(`${foc ? theme.fg("accent", "> ") : "  "}${theme.fg(foc ? "accent" : "text", LABELS[f].padEnd(13))} ${val}`);
				if (f === "color" && foc) {
					const swatches = colors.map((c) => (c === draft.color ? `[${colorize(c, "●")}]` : ` ${colorize(c, "●")} `)).join("");
					add(`     ${swatches}`);
				}
			}
			add(theme.fg(bc, "─".repeat(width)));
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

/** Parse the raw returns-schema text. Returns `{ schema }` (schema undefined = cleared)
 * on success, or `{ error }` describing why it is not a usable schema object. */
function parseReturnsDraft(raw: string): { schema?: ReturnsSchema } | { error: string } {
	const t = raw.trim();
	if (!t) return { schema: undefined };
	let parsed: unknown;
	try {
		parsed = JSON.parse(t);
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "must be a JSON object (a schema), not an array or scalar" };
	return { schema: parsed as ReturnsSchema };
}

export async function openEditor(ctx: ExtensionContext, agent: AgentConfig): Promise<{ oldName: string; newName: string } | undefined> {
	const refusal = agentMutationRefusal(agent, "edit");
	if (refusal) {
		ctx.ui.notify(refusal, "warning");
		return undefined;
	}
	const bundledIdentity = agent.source === "bundled";
	if (bundledIdentity) ctx.ui.notify(`Changes to ${agent.name} will be saved as a user override; the bundled default is unchanged.`, "info");
	const avail = ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll();
	const models = avail.map((m: any) => `${m.provider}/${m.id}`);
	// Include every durable role, including this one. MAX_SPAWN_DEPTH owns recursion safety.
	const roster = discoverAgents(ctx.cwd, { includeProject: (ctx as any).isProjectTrusted?.() ?? false }).agents.map((a) => a.name);
	const draft: Draft = {
		name: agent.name,
		displayName: agent.displayName ?? "",
		model: agent.model ?? "",
		fallback: agent.fallback.join(", "),
		auto: agent.auto,
		thinking: agent.thinking ?? "",
		readonly: agent.readonly,
		conventions: agent.conventions,
		color: agent.color,
		tools: agent.tools?.join(", ") ?? "",
		spawn: agent.spawn.join(", "),
		returns: agent.returns ? JSON.stringify(agent.returns, null, 2) : "",
		description: agent.description,
		systemPrompt: agent.systemPrompt,
	};
	const csv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
	let focus = 0;
	let page: "basic" | "advanced" = "basic";
	while (true) {
		const r = await showEditorOverlay(ctx, agent.name, draft, models, focus, page);
		if (r.action === "cancel") return undefined;
		if (r.action === "save") {
			const returnsResult = parseReturnsDraft(r.draft.returns);
			if ("error" in returnsResult) {
				ctx.ui.notify(`Returns schema not saved — ${returnsResult.error}. Fix the JSON or clear the field.`, "error");
				page = "advanced";
				focus = ADVANCED_FIELDS.indexOf("returns");
				continue; // reopen with the draft intact, cursor on the bad field
			}
			const newName = r.draft.name.trim() || agent.name;
			if (bundledIdentity && newName !== agent.name) {
				ctx.ui.notify("A bundled role cannot be renamed. Create a new role instead.", "warning");
				r.draft.name = agent.name;
				focus = BASIC_FIELDS.indexOf("name");
				page = "basic";
				continue;
			}
			const tools = csv(r.draft.tools);
			const updated: AgentConfig = {
				...agent,
				name: newName,
				displayName: r.draft.displayName.trim() || undefined,
				model: r.draft.model || undefined,
				fallback: csv(r.draft.fallback),
				// Auto is dashboard-owned so opening the editor cannot overwrite staged flips.
				auto: agent.auto,
				thinking: r.draft.thinking || undefined,
				readonly: r.draft.readonly,
				conventions: r.draft.conventions,
				color: r.draft.color,
				tools: tools.length ? tools : undefined,
				spawn: csv(r.draft.spawn),
				returns: returnsResult.schema,
				description: r.draft.description,
				systemPrompt: r.draft.systemPrompt,
			};
			if (newName !== agent.name) {
				try {
					const newPath = renameUserAgentFile(updated);
					ctx.ui.notify(`Renamed ${agent.name} → ${newName}. Run /reload for /${path.basename(newPath, ".md")}.`, "info");
					return { oldName: agent.name, newName };
				} catch (error) {
					const message = (error as NodeJS.ErrnoException).code === "EEXIST" ? "That role name already has a user definition." : "Could not rename this role.";
					ctx.ui.notify(message, "error");
					focus = BASIC_FIELDS.indexOf("name");
					page = "basic";
					continue;
				}
			} else {
				if (bundledIdentity) materializeUserOverride(updated);
				else updateAgentFile(updated);
				ctx.ui.notify(`Saved ${agent.name}${bundledIdentity ? " as a user override" : ""}`, "info");
			}
			return undefined;
		}
		focus = r.focus;
		page = r.page;
		if (r.field === "name") {
			const v = await ctx.ui.input("Role / command identity", draft.name);
			if (v !== undefined && v.trim()) draft.name = v.trim();
		} else if (r.field === "displayName") {
			const v = await ctx.ui.input("Display name (optional human-facing name)", draft.displayName);
			if (v !== undefined) draft.displayName = v;
		} else if (r.field === "tools") {
			const readonly = await ctx.ui.confirm("Tool access", "Restrict this agent to read-only tools?\nChoose No for default or custom full access.");
			const picked = await pickTools(ctx, csv(draft.tools));
			if (picked !== undefined) {
				draft.readonly = readonly;
				draft.tools = picked.join(", ");
			}
		} else if (r.field === "spawn") {
			const picked = await pickMulti(ctx, "Spawn targets", roster.map((n) => ({ name: n })), csv(draft.spawn), "agents this one may itself delegate to");
			if (picked !== undefined) draft.spawn = picked.join(", ");
		} else if (r.field === "fallback") {
			const picked = await pickMulti(ctx, "Fallback models", models.map((m) => ({ name: m })), csv(draft.fallback), "backup models, tried in the order selected, on provider errors only");
			if (picked !== undefined) draft.fallback = picked.join(", ");
		} else if (r.field === "returns") {
			const v = await ctx.ui.editor("Returns schema — JSON object, empty = none", draft.returns);
			if (v !== undefined) draft.returns = v;
		} else {
			const title = r.field === "description"
				? "When to delegate — sent to the parent for routing"
				: "Agent instructions — Markdown used as the child prompt";
			const v = await ctx.ui.editor(title, draft[r.field]);
			if (v !== undefined) draft[r.field] = v;
		}
	}
}
