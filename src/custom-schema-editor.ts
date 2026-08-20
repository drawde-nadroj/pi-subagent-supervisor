import type { ReturnsSchema } from "./returns.ts";

export const CUSTOM_FIELD_TYPES = ["string", "number", "boolean", "string-list", "number-list", "boolean-list"] as const;
export type CustomFieldType = typeof CUSTOM_FIELD_TYPES[number];

export interface CustomSchemaField {
	name: string;
	type: CustomFieldType;
	required: boolean;
}

export interface CustomSchemaEditorState {
	fields: CustomSchemaField[];
	selected: number;
}

export type CustomSchemaDecodeResult =
	| { kind: "compatible"; editor: CustomSchemaEditorState }
	| { kind: "unsupported" };

const ROOT_KEYS = new Set(["type", "properties", "required"]);
const SCALAR_KEYS = new Set(["type"]);
const ARRAY_KEYS = new Set(["type", "items"]);
const MAX_ARRAY_INDEX = 4_294_967_294n;

/** ECMAScript array-index names are reordered ahead of other object keys. */
export function isCanonicalArrayIndexName(name: string): boolean {
	return /^(?:0|[1-9]\d*)$/u.test(name) && BigInt(name) <= MAX_ARRAY_INDEX;
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function decodeFieldType(schema: ReturnsSchema): CustomFieldType | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	if (schema.type === "string" || schema.type === "number" || schema.type === "boolean") {
		return hasOnlyKeys(schema, SCALAR_KEYS) ? schema.type : undefined;
	}
	if (schema.type !== "array" || !hasOnlyKeys(schema, ARRAY_KEYS) || !schema.items || typeof schema.items !== "object") return undefined;
	if (!hasOnlyKeys(schema.items, SCALAR_KEYS)) return undefined;
	if (schema.items.type === "string" || schema.items.type === "number" || schema.items.type === "boolean") return `${schema.items.type}-list`;
	return undefined;
}

/** Decode only the exact flat object subset the guided editor can represent losslessly. */
export function decodeCustomSchema(schema: ReturnsSchema): CustomSchemaDecodeResult {
	if (!schema || typeof schema !== "object" || schema.type !== "object" || !hasOnlyKeys(schema, ROOT_KEYS)) return { kind: "unsupported" };
	if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return { kind: "unsupported" };
	if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))) return { kind: "unsupported" };
	const propertyNames = Object.keys(schema.properties);
	if (propertyNames.some(isCanonicalArrayIndexName)) return { kind: "unsupported" };
	const required = schema.required ?? [];
	if (new Set(required).size !== required.length || required.some((name) => !Object.hasOwn(schema.properties!, name))) return { kind: "unsupported" };
	const requiredNames = new Set(required);
	const fields: CustomSchemaField[] = [];
	for (const [name, fieldSchema] of Object.entries(schema.properties)) {
		const type = decodeFieldType(fieldSchema);
		if (!type) return { kind: "unsupported" };
		fields.push({ name, type, required: requiredNames.has(name) });
	}
	return { kind: "compatible", editor: { fields, selected: fields.length ? 0 : -1 } };
}

function fieldSchema(type: CustomFieldType): ReturnsSchema {
	if (type.endsWith("-list")) return { type: "array", items: { type: type.slice(0, -5) as "string" | "number" | "boolean" } };
	return { type };
}

/** Canonical schema generation preserves authored field order in properties and required. */
export function customSchemaFromFields(fields: readonly CustomSchemaField[]): ReturnsSchema {
	const properties = Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field.type)]));
	const required = fields.filter((field) => field.required).map((field) => field.name);
	return { type: "object", properties, required };
}

export function validateCustomFields(fields: readonly CustomSchemaField[]): string[] {
	if (!fields.length) return ["Custom needs at least one field."];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const [index, field] of fields.entries()) {
		if (!field.name.trim()) errors.push(`Field ${index + 1} needs a name.`);
		else if (isCanonicalArrayIndexName(field.name)) errors.push(`Field name “${field.name}” is an array index and cannot preserve guided field order.`);
		else if (seen.has(field.name)) errors.push(`Field name “${field.name}” is duplicated.`);
		seen.add(field.name);
	}
	return errors;
}

export function addCustomField(state: CustomSchemaEditorState, name: string): void {
	state.fields.push({ name, type: "string", required: false });
	state.selected = state.fields.length - 1;
}

export function renameCustomField(state: CustomSchemaEditorState, index: number, name: string): void {
	const field = state.fields[index];
	if (field) field.name = name;
}

export function deleteCustomField(state: CustomSchemaEditorState, index: number): void {
	if (!state.fields[index]) return;
	state.fields.splice(index, 1);
	state.selected = state.fields.length ? Math.min(index, state.fields.length - 1) : -1;
}

export function moveCustomField(state: CustomSchemaEditorState, index: number, direction: -1 | 1): void {
	const target = index + direction;
	if (!state.fields[index] || target < 0 || target >= state.fields.length) return;
	[state.fields[index], state.fields[target]] = [state.fields[target]!, state.fields[index]!];
	state.selected = target;
}

export function cycleCustomFieldType(state: CustomSchemaEditorState, index: number, direction: -1 | 1): void {
	const field = state.fields[index];
	if (!field) return;
	const current = CUSTOM_FIELD_TYPES.indexOf(field.type);
	field.type = CUSTOM_FIELD_TYPES[(current + direction + CUSTOM_FIELD_TYPES.length) % CUSTOM_FIELD_TYPES.length]!;
}

export function toggleCustomFieldRequired(state: CustomSchemaEditorState, index: number): void {
	const field = state.fields[index];
	if (field) field.required = !field.required;
}
