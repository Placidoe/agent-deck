// Optional fixture appearance, never touches the live app profile.
export async function qaAppearance(page) {
  const mode = process.env.AGENT_DECK_QA_APPEARANCE;
  if (!["light", "dark"].includes(mode)) return;
  await page.evaluate(mode => localStorage.setItem("agent-deck:appearance", mode), mode);
  await page.reload();
  await page.waitForFunction(mode => document.documentElement.dataset.appearance === mode, mode);
}
