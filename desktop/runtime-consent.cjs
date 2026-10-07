const { interactionMode } = require("./execution-mode.cjs");
const queues = new WeakMap();
async function saveRuntimeWithConsent(registry, input, confirm) {
  if (!registry) throw new Error("Runtime settings are not ready");
  if (input?.interactionMode !== undefined) interactionMode(input.interactionMode);
  // Serialize windows/IPC callers so a delayed warning cannot overwrite a
  // later request to return to manual mode.
  const operation = (queues.get(registry) || Promise.resolve()).then(async () => {
    const current = registry.runtimeSettings();
    if (input?.interactionMode === "autonomous" && current.interactionMode !== "autonomous") {
      if (!confirm || !await confirm()) return current;
    }
    return registry.saveRuntimeSettings(input);
  });
  queues.set(registry, operation.catch(() => {}));
  return operation;
}
module.exports = { saveRuntimeWithConsent };
