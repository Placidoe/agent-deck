// Structural preflight for app-server DynamicToolSpec (not Responses tools).
// Optional function arguments remain optional; strict output-schema rules do
// not apply to this RPC envelope. This is not a full JSON Schema validator.
function assertDynamicTools(tools) {
  if (tools === undefined) return;
  const fail = (where, reason) => { throw new Error(`Invalid Codex dynamicTools at ${where}: ${reason}`); };
  if (!Array.isArray(tools)) fail("$", "expected an array of flat DynamicToolSpec objects");
  const names = new Set();
  for (const [index, tool] of tools.entries()) {
    const where = `$[${index}]`;
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) fail(where, "expected a tool object");
    if (tool.type !== undefined || tool.tools !== undefined) fail(where, "Responses API wrappers are unsupported; use namespace, name, description and inputSchema on each tool");
    for (const field of ["name", "namespace"]) {
      if (field === "namespace" && tool[field] === undefined) continue;
      if (typeof tool[field] !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool[field])) fail(where, `invalid ${field}`);
    }
    if (typeof tool.description !== "string") fail(where, "description must be a string");
    if (!tool.inputSchema || tool.inputSchema.type !== "object" || Array.isArray(tool.inputSchema)) fail(where, "inputSchema must be an object schema");
    const key = JSON.stringify([tool.namespace || "", tool.name]);
    if (names.has(key)) fail(where, "duplicate namespace/name");
    names.add(key);
  }
  return tools;
}
module.exports = { assertDynamicTools };
