/**
 * Reusable two-press confirmation gesture for terminal overlays.
 *
 * The first confirm/cancel key arms that action; pressing the same key again
 * commits it. Pressing the opposite action switches the arm. Pressing any other
 * key disarms and lets the caller keep handling that key normally.
 */
export type TwoPressAction = "confirm" | "cancel";

export type TwoPressResult =
	| { kind: "arm"; action: TwoPressAction }
	| { kind: "commit"; action: TwoPressAction }
	| { kind: "disarm"; previous: TwoPressAction }
	| { kind: "pass" };

export interface TwoPressConfirmationOptions {
	isConfirm: (data: string) => boolean;
	isCancel: (data: string) => boolean;
}

export class TwoPressConfirmation {
	private armedAction: TwoPressAction | null = null;
	private readonly isConfirm: (data: string) => boolean;
	private readonly isCancel: (data: string) => boolean;

	constructor(options: TwoPressConfirmationOptions) {
		this.isConfirm = options.isConfirm;
		this.isCancel = options.isCancel;
	}

	get armed(): TwoPressAction | null {
		return this.armedAction;
	}

	reset(): void {
		this.armedAction = null;
	}

	/** Return the border/theme color name that matches the current armed state. */
	borderColor(defaultColor = "accent"): "success" | "error" | string {
		if (this.armedAction === "confirm") return "success";
		if (this.armedAction === "cancel") return "error";
		return defaultColor;
	}

	/**
	 * Handle one key/input chunk.
	 *
	 * `arm` and `commit` should be consumed by the caller. `disarm` means the
	 * confirmation state was cleared, but the input was not a confirm/cancel key,
	 * so the caller should continue processing it as a normal gesture.
	 */
	handle(data: string): TwoPressResult {
		if (this.isConfirm(data)) return this.armOrCommit("confirm");
		if (this.isCancel(data)) return this.armOrCommit("cancel");
		if (!this.armedAction) return { kind: "pass" };
		const previous = this.armedAction;
		this.armedAction = null;
		return { kind: "disarm", previous };
	}

	private armOrCommit(action: TwoPressAction): TwoPressResult {
		if (this.armedAction === action) {
			this.armedAction = null;
			return { kind: "commit", action };
		}
		this.armedAction = action;
		return { kind: "arm", action };
	}
}
