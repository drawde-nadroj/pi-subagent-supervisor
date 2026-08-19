// Raw-ANSI truecolor helpers (house style; survives pi updates — no theme dependency).
export const COLOR_HEX: Record<string, [number, number, number]> = {
	red: [235, 107, 111],
	orange: [232, 154, 75],
	yellow: [229, 192, 88],
	green: [126, 200, 121],
	cyan: [95, 199, 196],
	blue: [95, 135, 255],
	purple: [186, 134, 232],
	magenta: [209, 131, 232],
	pink: [232, 131, 180],
	gray: [150, 150, 160],
	white: [220, 220, 225],
};

function rgb([r, g, b]: [number, number, number], s: string): string {
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function colorize(color: string, text: string): string {
	const hex = COLOR_HEX[color] ?? COLOR_HEX.gray;
	return rgb(hex, text);
}

export function colorDot(color: string): string {
	return colorize(color, "●");
}

export function dim(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
