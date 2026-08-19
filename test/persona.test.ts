import assert from "node:assert/strict";
import {
	createNestedPersona,
	createRootPersonas,
	formatLiteralPersona,
	formatPersona,
	type PersonaDescriptor,
} from "../src/persona.ts";

const agent = (name: string, displayName?: string) => ({ name, displayName });

// A future regression that applies parallel friend labels to ordinary calls must fail here.
assert.deepEqual(createRootPersonas("single", [agent("worker", "Ada")]), [{ base: "Ada", friendDepth: 0 }]);
assert.deepEqual(createRootPersonas("sequence", [agent("worker", "Ada"), agent("worker", "Ada")]), [
	{ base: "Ada", friendDepth: 0 },
	{ base: "Ada", friendDepth: 0 },
]);

// Parallel friend depth follows the original request order for repeated durable roles.
assert.deepEqual(createRootPersonas("parallel", [agent("worker", "Ada"), agent("worker", "Ada"), agent("worker", "Ada")]), [
	{ base: "Ada", friendDepth: 0 },
	{ base: "Ada", friendDepth: 1 },
	{ base: "Ada", friendDepth: 2 },
]);

assert.deepEqual(createRootPersonas("parallel", [agent("worker", "Ada"), agent("reviewer", "Grace"), agent("worker", "Ada")]), [
	{ base: "Ada", friendDepth: 0 },
	{ base: "Grace", friendDepth: 0 },
	{ base: "Ada", friendDepth: 1 },
]);

const secondAda: PersonaDescriptor = { base: "Ada", friendDepth: 1 };
assert.equal(formatLiteralPersona(secondAda), "Ada’s friend");
assert.equal(formatLiteralPersona({ base: "Ada", friendDepth: 2 }), "Ada’s friend’s friend");
assert.equal(formatLiteralPersona({ base: "James", friendDepth: 1 }), "James’s friend");
assert.equal(formatPersona({ base: "Ada", friendDepth: 2 }, 16), "Ada’s friend ×2");
assert.equal(formatPersona({ base: "Ada", friendDepth: 1 }, 7), "Ada ×2");
assert.equal(formatPersona({ base: "Ada", friendDepth: 5 }, 7), "Ada ×6");

const inherited = createNestedPersona({ role: "worker", persona: secondAda }, agent("worker", "Changed later"));
assert.deepEqual(inherited, { base: "Ada", friendDepth: 1 });
assert.deepEqual(createNestedPersona({ role: "worker", persona: secondAda }, agent("reviewer", "Grace")), { base: "Grace", friendDepth: 0 });

const config = agent("worker", "Ada");
const historical = createRootPersonas("parallel", [config])[0]!;
config.displayName = "Renamed";
assert.deepEqual(historical, { base: "Ada", friendDepth: 0 });

console.log("persona unit tests passed");
