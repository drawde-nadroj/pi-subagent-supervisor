/** Structured returns: an agent's optional `returns:` frontmatter is a small
 * JSON-schema subset. The child is asked to end its reply with a ```json block
 * matching it; we extract, validate, and give one repair turn on mismatch.
 * Tolerant by design — a schema miss flags the run, it never destroys the prose. */

export interface ReturnsSchema {
	type?: "object" | "array" | "string" | "number" | "boolean";
	properties?: Record<string, ReturnsSchema>;
	required?: string[];
	items?: ReturnsSchema;
	enum?: Array<string | number>;
}

export function buildReturnsInstruction(schema: ReturnsSchema): string {
	return [
		"",
		"IMPORTANT — structured return: end your final reply with a ```json code block containing ONLY a JSON value that matches this schema (your prose findings come first, the JSON block last):",
		"```json-schema",
		JSON.stringify(schema),
		"```",
	].join("\n");
}

interface JsonCandidate {
	json: string;
	start: number;
	end: number;
}

function jsonCandidates(text: string): JsonCandidate[] {
	const candidates: JsonCandidate[] = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => ({
		json: match[1],
		start: match.index,
		end: match.index + match[0].length,
	}));
	// Fallback: find the nearest parseable trailing object/array. Scanning from
	// the end avoids treating braces in the preceding prose as part of the JSON.
	const end = text.trimEnd().length;
	for (let start = end - 1; start >= 0; start--) {
		if (text[start] !== "{" && text[start] !== "[") continue;
		const json = text.slice(start, end);
		try {
			JSON.parse(json);
			candidates.push({ json, start, end });
			break;
		} catch {
			/* try the preceding object/array delimiter */
		}
	}
	return candidates;
}

/** Pull the last fenced ```json block, or a trailing bare JSON object/array. */
export function extractJsonBlock(text: string): unknown | undefined {
	const candidates = jsonCandidates(text);
	for (let i = candidates.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(candidates[i].json);
		} catch {
			/* try earlier candidate */
		}
	}
	return undefined;
}

/** Pretty-print the structured return while preserving its machine-readable JSON fence. */
export function formatReturnsJson(text: string): string {
	const candidates = jsonCandidates(text);
	for (let i = candidates.length - 1; i >= 0; i--) {
		const candidate = candidates[i];
		try {
			const pretty = JSON.stringify(JSON.parse(candidate.json), null, 2);
			const replacement = `\`\`\`json\n${pretty}\n\`\`\``;
			return text.slice(0, candidate.start) + replacement + text.slice(candidate.end);
		} catch {
			/* try earlier candidate */
		}
	}
	return text;
}

/** Minimal structural validation against the schema subset. Returns error strings ([] = valid). */
export function validateReturns(schema: ReturnsSchema, value: unknown, path = "$"): string[] {
	const errors: string[] = [];
	const actualType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
	if (schema.type && actualType !== schema.type) {
		errors.push(`${path}: expected ${schema.type}, got ${actualType}`);
		return errors;
	}
	if (schema.enum && !schema.enum.includes(value as string | number)) {
		errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
	}
	switch (schema.type) {
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				errors.push(`${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
				return errors;
			}
			const obj = value as Record<string, unknown>;
			for (const key of schema.required ?? []) {
				if (!(key in obj)) errors.push(`${path}.${key}: required property missing`);
			}
			for (const [key, sub] of Object.entries(schema.properties ?? {})) {
				if (key in obj) errors.push(...validateReturns(sub, obj[key], `${path}.${key}`));
			}
			return errors;
		}
		case "array": {
			if (!Array.isArray(value)) {
				errors.push(`${path}: expected array, got ${typeof value}`);
				return errors;
			}
			if (schema.items) for (let i = 0; i < value.length; i++) errors.push(...validateReturns(schema.items, value[i], `${path}[${i}]`));
			return errors;
		}
		case "string":
			if (typeof value !== "string") errors.push(`${path}: expected string, got ${typeof value}`);
			return errors;
		case "number":
			if (typeof value !== "number") errors.push(`${path}: expected number, got ${typeof value}`);
			return errors;
		case "boolean":
			if (typeof value !== "boolean") errors.push(`${path}: expected boolean, got ${typeof value}`);
			return errors;
		default:
			return errors; // no type constraint — accept anything
	}
}

/** Validate a child's final text against the agent's returns schema.
 * null = valid; otherwise a repair message describing what's wrong. */
export function checkReturns(schema: ReturnsSchema, finalText: string): string | null {
	const value = extractJsonBlock(finalText);
	if (value === undefined) return "Your reply is missing the required trailing ```json block. Reply again: keep your findings brief, then end with a ```json block matching the schema you were given.";
	const errors = validateReturns(schema, value);
	if (errors.length === 0) return null;
	return `Your trailing JSON block did not match the required schema:\n${errors.slice(0, 8).join("\n")}\nReply again with a corrected \`\`\`json block (prose first, JSON last).`;
}
