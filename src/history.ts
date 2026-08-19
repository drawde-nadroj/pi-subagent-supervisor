import { clearRunLog } from "./runlog.ts";

export type HistoryAction = "on" | "off" | "status" | "clear";
export type HistoryCommandResult = { message: string; level: "info" | "error" };

export interface HistoryPreference {
	getHistoryEnabled(): boolean;
	setHistoryEnabled(on: boolean): void;
}

/** Parse only the `/agents` argument suffix owned by history commands. */
export function parseHistoryCommand(args: string): HistoryAction | "invalid" | undefined {
	const parts = args.trim().toLowerCase().split(/\s+/);
	if (parts[0] !== "history") return undefined;
	if (parts.length !== 2) return "invalid";
	return parts[1] === "on" || parts[1] === "off" || parts[1] === "status" || parts[1] === "clear"
		? parts[1]
		: "invalid";
}

/** Apply one parsed history command at a small, UI-independent boundary. */
export function executeHistoryCommand(
	action: HistoryAction | "invalid",
	state: HistoryPreference,
	runLogPath: string,
	clear: (file: string) => boolean = clearRunLog,
): HistoryCommandResult {
	if (action === "invalid") return { message: "Usage: /agents history on|off|status|clear", level: "error" };
	if (action === "status") {
		return {
			message: state.getHistoryEnabled()
				? "Subagent history recording is ON. New completed runs are appended."
				: "Subagent history recording is OFF. Existing history is retained.",
			level: "info",
		};
	}
	if (action === "on" || action === "off") {
		const enabled = action === "on";
		try {
			state.setHistoryEnabled(enabled);
		} catch (error) {
			return {
				message: `Could not turn subagent history recording ${action.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
				level: "error",
			};
		}
		return {
			message: enabled
				? "Subagent history recording is ON. New completed runs will be appended; existing history is unchanged."
				: "Subagent history recording is OFF. Existing history is retained.",
			level: "info",
		};
	}
	try {
		const cleared = clear(runLogPath);
		const recording = state.getHistoryEnabled()
			? "Recording remains ON; new completed runs will be appended."
			: "Recording remains OFF.";
		return {
			message: `${cleared ? "Subagent run history cleared." : "No subagent run history file exists."} ${recording}`,
			level: "info",
		};
	} catch (error) {
		return {
			message: `Could not clear subagent run history: ${error instanceof Error ? error.message : String(error)}`,
			level: "error",
		};
	}
}
