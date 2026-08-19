import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const LEGACY_DATA_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_FILES = ["state.json", "runs.jsonl"] as const;

export function getSubagentsDataDir(): string {
	return path.join(getAgentDir(), "pi-subagents");
}

export function getDefaultStatePath(): string {
	return path.join(getSubagentsDataDir(), "state.json");
}

export function getDefaultRunLogPath(): string {
	return path.join(getSubagentsDataDir(), "runs.jsonl");
}

/** Best-effort compatibility copy from installs that stored data beside the extension. */
export function migrateLegacyStorage(legacyDir = LEGACY_DATA_DIR, destinationDir = getSubagentsDataDir()): void {
	try {
		if (!LEGACY_FILES.some((name) => fs.existsSync(path.join(legacyDir, name)))) return;
		fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(destinationDir, 0o700);
	} catch {
		return; // migration must never prevent extension startup
	}
	for (const name of LEGACY_FILES) {
		const source = path.join(legacyDir, name);
		const destination = path.join(destinationDir, name);
		try {
			if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
			fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
			fs.chmodSync(destination, 0o600);
		} catch {
			/* best-effort; another process may have won the exclusive copy */
		}
	}
}
