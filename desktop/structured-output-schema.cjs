// Local structural preflight for strict output schemas, not a full JSON Schema
// validator. Optional data must be expressed explicitly as a nullable field.
function assertStrictOutputSchema(schema) {
  if (!schema || schema.type !== "object" || schema.anyOf) {
    throw new Error("Invalid structured output schema at $: root must be an object without anyOf");
  }
  function visit(node, path) {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" || node.type?.includes?.("object") || node.properties) {
      const keys = Object.keys(node.properties || {});
      const required = node.required;
      if (node.additionalProperties !== false) {
        throw new Error(`Invalid structured output schema at ${path}: additionalProperties must be false`);
      }
      if (!Array.isArray(required) || required.length !== new Set(required).size ||
          keys.some(key => !required.includes(key)) || required.some(key => !keys.includes(key))) {
        const missing = keys.filter(key => !required?.includes?.(key));
        throw new Error(`Invalid structured output schema at ${path}: required must contain every property exactly once${missing.length ? "; missing " + missing.join(", ") : ""}`);
      }
    }
    for (const [key, child] of Object.entries(node.properties || {})) visit(child, `${path}.properties.${key}`);
    if (node.items) visit(node.items, `${path}.items`);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      for (const [index, child] of (node[keyword] || []).entries()) visit(child, `${path}.${keyword}[${index}]`);
    }
    for (const [key, child] of Object.entries(node.$defs || {})) visit(child, `${path}.$defs.${key}`);
  }
  visit(schema, "$");
  return schema;
}
module.exports = { assertStrictOutputSchema };
