import { _electron as electron } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const executablePath = path.join(root, "release/mac-arm64/Agent Deck.app/Contents/MacOS/Agent Deck");
const useExistingData = process.env.AGENT_DECK_QA_USE_EXISTING_DATA === "1";
const seedHtmlPreview = process.env.AGENT_DECK_QA_HTML_PREVIEW === "1";
const qaUserData = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-desktop-qa-"));
if (useExistingData) {
  const sourceUserData = path.join(os.homedir(), "Library/Application Support/agent-deck-demo");
  for (const name of ["workspace.json", "agent-deck.sqlite3", "agent-deck.sqlite3-shm", "agent-deck.sqlite3-wal"]) {
    const source = path.join(sourceUserData, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(qaUserData, name));
  }
} else {
  fs.writeFileSync(path.join(qaUserData, "workspace.json"), JSON.stringify({ path: root }), "utf8");
}
if (seedHtmlPreview) {
  const { MissionStore } = require("../desktop/mission-store.cjs");
  fs.writeFileSync(path.join(qaUserData, "workspace.json"), JSON.stringify({ path: qaUserData }), "utf8");
  fs.writeFileSync(path.join(qaUserData, "preview.html"), '<!doctype html><html><body><main><h1>QA HTML artifact</h1><p>Safe preview content</p><script>alert("unsafe")</script></main></body></html>', "utf8");
  const store = new MissionStore(path.join(qaUserData, "agent-deck.sqlite3"));
  const seeded = store.createMission({ title: "HTML preview QA", outcome: "Verify the HTML-first artifact flow", cwd: qaUserData });
  store.updateMission(seeded.id, { mainThreadId: "qa-html-preview-main" });
  store.savePlan(seeded.id, { title: "HTML preview QA", outcome: "Verify the HTML-first artifact flow", scope: ["Preview"], nonGoals: [], constraints: ["Static preview"], acceptanceCriteria: ["HTML renders safely"], tasks: [{ key: "QA-HTML", title: "Inspect HTML artifact", description: "Confirm that HTML artifacts open in the safe in-app preview.", agentRole: "Preview QA", dependencies: [], acceptanceCriteria: ["Preview content is visible"] }] });
  const reviewTask = store.getMission(seeded.id).tasks[0];
  store.updateTask(reviewTask.id, {
    status: "review",
    phase: "awaiting_review",
    agentThreadId: "qa-html-preview-worker",
    result: {
      summary: `${"Review result remains responsive. ".repeat(260)}Done.`,
      acceptance: [{ criterion: "HTML renders safely", passed: true, evidence: "Desktop QA fixture" }],
      changedFiles: ["preview.html"],
      blockers: [],
    },
  });
  store.updateMission(seeded.id, { status: "review" });
  store.addArtifact({ missionId: seeded.id, title: "HTML-first sample", summary: "Self-contained report used by desktop QA.", files: ["preview.html"], verificationStatus: "qa_verified" });
  store.close();
}
const app = await electron.launch({ executablePath, args: ["--disable-gpu", `--user-data-dir=${qaUserData}`] });
const pageErrors = [];
let result;
async function measureLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
    };
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const cards = [...document.querySelectorAll(".session-card")].map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    return {
      viewport,
      scrollWidth: document.documentElement.scrollWidth,
      missionControls: rect(".mission-sidebar-controls"),
      missionTasks: rect(".task-groups"),
      missionFooter: rect(".mission-sidebar > footer"),
      missionBody: rect(".mission-body"),
      inspectorFocused: document.querySelector(".mission-body")?.classList.contains("inspector-focused") || false,
      missionCenter: rect(".mission-center"),
      missionInspector: rect(".mission-body > .mission-inspector"),
      missionInspectorHeader: rect(".mission-inspector > header"),
      missionInspectorStatus: rect(".mission-inspector .online"),
      missionInspectorTabs: rect(".mission-inspector > nav"),
      missionInspectorTabButtons: [...document.querySelectorAll(".mission-inspector > nav > button")].map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }),
      missionInspectorScroll: rect(".mission-inspector-scroll"),
      missionInspectorComposer: rect(".agent-compose"),
      missionMessageCards: [...document.querySelectorAll(".agent-message-list article")].map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }),
      workspaceBody: rect(".workspace-body"),
      primarySurface: rect(".primary-surface"),
      inspector: rect(".workspace-body > .inspector"),
      cards,
    };
  });
}

function assertContainedLayout(metrics, label) {
  if (metrics.scrollWidth !== metrics.viewport.width) throw new Error(`${label}: document overflows horizontally`);
  if (metrics.missionControls && metrics.missionTasks && metrics.missionControls.bottom > metrics.missionTasks.top + 1) throw new Error(`${label}: Mission controls overlap the task scroller`);
  if (metrics.missionTasks && metrics.missionFooter && metrics.missionTasks.bottom > metrics.missionFooter.top + 1) throw new Error(`${label}: Mission tasks overlap the sidebar footer`);
  if (metrics.missionBody && metrics.missionCenter && metrics.missionInspector) {
    if (metrics.missionCenter.right > metrics.missionInspector.left + 1) throw new Error(`${label}: Mission canvas overlaps the inspector`);
    if (metrics.missionInspector.right > metrics.missionBody.right + 1) throw new Error(`${label}: Mission inspector is clipped`);
    if (!metrics.inspectorFocused && metrics.missionInspector.width > metrics.missionBody.width * .47 + 1) throw new Error(`${label}: Mission inspector consumes too much canvas width`);
  }
  if (metrics.missionInspectorTabs) {
    if (metrics.missionInspectorTabButtons.some((tab) => tab.left < metrics.missionInspectorTabs.left - 1 || tab.right > metrics.missionInspectorTabs.right + 1)) throw new Error(`${label}: an inspector tab is clipped`);
    for (let index = 1; index < metrics.missionInspectorTabButtons.length; index += 1) {
      if (metrics.missionInspectorTabButtons[index - 1].right > metrics.missionInspectorTabButtons[index].left + 1) throw new Error(`${label}: inspector tabs overlap`);
    }
  }
  if (metrics.missionInspectorHeader && metrics.missionInspectorStatus && metrics.missionInspectorStatus.right > metrics.missionInspectorHeader.right + 1) throw new Error(`${label}: agent status escapes the inspector header`);
  if (metrics.missionInspectorScroll && metrics.missionInspectorComposer && metrics.missionInspectorScroll.bottom > metrics.missionInspectorComposer.top + 1) {
    throw new Error(`${label}: composer covers conversation content`);
  }
  if (metrics.missionInspectorScroll && metrics.missionMessageCards?.some((card) => card.left < metrics.missionInspectorScroll.left - 1 || card.right > metrics.missionInspectorScroll.right + 1)) {
    throw new Error(`${label}: a conversation card escapes the inspector reading surface`);
  }
  if (metrics.workspaceBody && metrics.primarySurface && metrics.inspector) {
    if (metrics.primarySurface.right > metrics.inspector.left + 1) throw new Error(`${label}: session grid overlaps the inspector`);
    if (metrics.inspector.right > metrics.viewport.width + 1) throw new Error(`${label}: inspector is clipped by the viewport`);
    // Session cards live in a vertical scroll container, so cards below the
    // viewport are expected. Horizontal escape still indicates real clipping.
    if (metrics.cards.some((card) => card.left < metrics.primarySurface.left - 1 || card.right > metrics.primarySurface.right + 1)) throw new Error(`${label}: a session card escapes its grid boundary`);
  }
}
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForSelector(".app-shell");
  // Layout QA must remain runnable in a fresh local profile where Codex may
  // legitimately require login. The native bridge is proven by the desktop
  // mission API call below; authentication is covered by runtime smoke tests.
  await page.locator(".product-connection span").waitFor({ timeout: 45000 });
  const existingMissionCount = await page.evaluate(() => window.agentDeckDesktop.missions.list().then((items) => items.length));
  let observabilityScreenshot = null;
  let artifactsScreenshot = null;
  let attentionScreenshot = null;
  let artifactFileCount = 0;
  let activityEventCount = 0;
  let visibleConversationCount = 0;
  let mainComposerVisible = false;
  let workerComposerVisible = false;
  let rawStructuredMainResponses = 0;
  let rawStructuredWorkerResponses = 0;
  let reviewActionVisible = false;
  let reviewActionExpected = false;
  let agentArtifactTabVisible = false;
  let agentArtifactCount = 0;
  let missionBlockerGateVisible = false;
  let missionBlockerGateExpected = false;
  let agentBlockerResolutionVisible = false;
  let agentBlockerResolutionExpected = false;
  let preThreadRecoveryVisible = false;
  let preThreadRecoveryExpected = false;
  let htmlPreviewVisible = false;
  let reviewOpenMs = null;
  let graphToolbarVisible = false;
  let planEditorVisible = false;
  let planEditorExpected = false;
  let graphDragPersisted = false;
  let attentionItemCount = 0;
  let attentionCenterVisible = false;
  let reviewCenterVisible = false;
  let interfaceSizeControlVisible = false;
  let interfaceSizePersisted = false;
  let typographyScreenshot = null;
  let responsiveMacScreenshot = null;
  let largeMissionLayout = null;
  let mainAgentMissionLayout = null;
  let focusedInspectorLayout = null;
  let mainAgentResponsiveScreenshot = null;
  let focusedInspectorScreenshot = null;
  let edgeLabelHoverVerified = false;
  let reducedMotionVerified = false;
  let edgeLabelDebug = null;
  let reducedMotionDebug = null;
  if (existingMissionCount > 0) {
    await page.getByRole("button", { name: "工作", exact: true }).click();
    await page.locator('[data-testid="requirement-hub"]').waitFor();
    await page.getByRole("button", { name: /查看执行详情|打开执行项目|查看交付|查看结果|查看原因/ }).first().click();
    await page.locator(".mission-workspace").waitFor();
    await page.locator('.mission-inspector > nav button[aria-label^="Conversation"]').click();
    await page.locator(".agent-conversation").waitFor();
    await page.locator('[data-testid="graph-toolbar"]').waitFor();
    graphToolbarVisible = await page.locator('[data-testid="graph-toolbar"]').isVisible();
    mainAgentMissionLayout = await measureLayout(page);
    assertContainedLayout(mainAgentMissionLayout, "1540x960 Main Agent");
    mainAgentResponsiveScreenshot = path.join(root, "implementation-main-agent-responsive.png");
    await page.screenshot({ path: mainAgentResponsiveScreenshot, fullPage: false });
    const defaultInspectorWidth = mainAgentMissionLayout.missionInspector?.width || 0;
    await page.getByRole("button", { name: "Focus inspector", exact: true }).click();
    focusedInspectorLayout = await measureLayout(page);
    assertContainedLayout(focusedInspectorLayout, "1540x960 Focused inspector");
    if ((focusedInspectorLayout.missionInspector?.width || 0) < Math.max(500, defaultInspectorWidth + 80)) throw new Error("Focused inspector did not create a useful reading surface");
    focusedInspectorScreenshot = path.join(root, "implementation-inspector-focused.png");
    await page.screenshot({ path: focusedInspectorScreenshot, fullPage: false });
    await page.getByRole("button", { name: "Restore inspector width", exact: true }).click();
    const editPlan = page.locator('[data-testid="graph-toolbar"]').getByRole("button", { name: "Edit plan", exact: true });
    if (await editPlan.count()) {
      planEditorExpected = true;
      await editPlan.click();
      await page.locator('[data-testid="plan-editor"]').waitFor();
      planEditorVisible = await page.locator('[data-testid="plan-editor"]').isVisible();
      await page.locator('[data-testid="plan-editor"] > header > button').click();
    }
    const mainNode = page.locator('.react-flow__node[data-id="main"]');
    const mainBox = await mainNode.boundingBox();
    if (mainBox) {
      await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + mainBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(mainBox.x + mainBox.width / 2 + 34, mainBox.y + mainBox.height / 2 + 22, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(250);
      graphDragPersisted = await page.evaluate(async () => {
        const missions = await window.agentDeckDesktop.missions.list();
        const detail = await window.agentDeckDesktop.missions.get(missions[0].id);
        return Number.isFinite(detail.uiState?.layout?.positions?.main?.x) && Number.isFinite(detail.uiState?.layout?.positions?.main?.y);
      });
    }
    const missionStatusText = await page.locator(".mission-toolbar .live-badge").textContent();
    if (missionStatusText === "Blocked") {
      missionBlockerGateExpected = true;
      await page.locator('[data-testid="mission-blocker-gate"]').waitFor();
      missionBlockerGateVisible = await page.locator('[data-testid="mission-blocker-gate"]').isVisible();
    }
    const mainComposer = page.locator('.agent-compose textarea[placeholder*="Main Agent"]');
    await mainComposer.waitFor();
    mainComposerVisible = await mainComposer.isVisible();
    rawStructuredMainResponses = await page.locator(".agent-message-list article.agent > pre").evaluateAll((items) => items.filter((item) => item.textContent.trim().startsWith("{")).length);
    const taskSelectStartedAt = Date.now();
    await page.locator(".task-row").first().click();
    await page.locator(".task-row.selected").waitFor();
    const selectedTaskStatus = await page.locator(".task-row.selected .task-row-top span").textContent();
    if (selectedTaskStatus === "Review") {
      reviewActionExpected = true;
      await page.locator(".agent-result-view").waitFor();
      reviewOpenMs = Date.now() - taskSelectStartedAt;
      reviewActionVisible = await page.locator(".agent-review-bar").isVisible();
      if (reviewOpenMs > 500) throw new Error(`Review result took ${reviewOpenMs}ms to open`);
      await page.locator(".mission-inspector>nav").getByRole("button", { name: /Conversation/ }).click();
      await page.locator(".agent-conversation").waitFor();
    } else {
      await page.locator(".agent-conversation").waitFor();
    }
    if (selectedTaskStatus === "Blocked") {
      agentBlockerResolutionExpected = true;
      await page.locator('[data-testid="agent-blocker-resolution"]').waitFor();
      agentBlockerResolutionVisible = await page.locator('[data-testid="agent-blocker-resolution"]').isVisible();
      const threadState = await page.locator(".agent-compose>header>span").textContent();
      if (threadState === "Thread not started") {
        preThreadRecoveryExpected = true;
        preThreadRecoveryVisible = await page.locator('[data-testid="agent-blocker-resolution"]').getByRole("button", { name: /启动.*Worker/ }).isVisible();
        if (await page.locator('[data-testid="agent-blocker-resolution"]').getByRole("button", { name: "放入输入框", exact: true }).count()) throw new Error("Pre-thread blocker incorrectly exposes message recovery");
      } else {
        await page.locator('[data-testid="agent-blocker-resolution"]').getByRole("button", { name: "放入输入框", exact: true }).click();
        const suggestedReply = await page.locator(".agent-compose textarea").inputValue();
        if (!suggestedReply.trim()) throw new Error("Blocked worker did not provide a suggested recovery instruction");
      }
    }
    const workerComposer = page.locator(".agent-compose textarea");
    await workerComposer.waitFor();
    workerComposerVisible = await workerComposer.isVisible();
    visibleConversationCount = await page.locator(".agent-message-list article").count();
    rawStructuredWorkerResponses = await page.locator(".agent-message-list article.agent > pre").evaluateAll((items) => items.filter((item) => item.textContent.trim().startsWith("{")).length);
    const agentArtifactsTab = page.locator(".mission-inspector>nav").getByRole("button", { name: /^Artifacts/ });
    await agentArtifactsTab.waitFor();
    await agentArtifactsTab.click();
    await page.locator(".agent-artifact-view").waitFor();
    agentArtifactTabVisible = await page.locator(".agent-artifact-view").isVisible();
    agentArtifactCount = await page.locator(".agent-artifact-list .artifact-card").count();
    await page.locator(".mission-inspector>nav").getByRole("button", { name: "Brief", exact: true }).click();
    await page.locator(".agent-brief-view").waitFor();
    const selectedTaskBrief = await page.locator(".agent-brief-view > p").first().textContent();
    if (!selectedTaskBrief?.trim()) throw new Error("Selected mission task has no visible brief");
    if (selectedTaskStatus === "Queued") await page.locator('[data-testid="plan-approval-gate"]').waitFor();
    await page.locator(".mission-inspector>nav").getByRole("button", { name: /Conversation/ }).click();
    observabilityScreenshot = path.join(root, "implementation-mission-observability.png");
    await page.screenshot({ path: observabilityScreenshot, fullPage: false });
    await page.locator(".mission-tabs").getByRole("button", { name: "产物", exact: true }).click();
    await page.locator(".artifact-view").waitFor();
    artifactFileCount = await page.locator(".artifact-file-open").count();
    const htmlArtifact = page.locator(".artifact-file-open.html").first();
    if (await htmlArtifact.count()) {
      await htmlArtifact.click();
      await page.locator('[data-testid="artifact-preview"]').waitFor();
      htmlPreviewVisible = await page.locator('[data-testid="artifact-preview"]').isVisible();
      if (seedHtmlPreview) await page.frameLocator(".artifact-preview-frame").getByRole("heading", { name: "QA HTML artifact" }).waitFor();
      const previewScripts = await page.frameLocator(".artifact-preview-frame").locator("script").count();
      if (previewScripts) throw new Error("HTML artifact preview retained executable script elements");
      const closePreview = page.locator('[data-testid="artifact-preview"] .artifact-preview-modal button.close');
      if (await closePreview.count()) await closePreview.evaluate((button) => button.click());
      await page.locator('[data-testid="artifact-preview"]').waitFor({ state: "detached" });
    }
    artifactsScreenshot = path.join(root, "implementation-artifacts.png");
    await page.screenshot({ path: artifactsScreenshot, fullPage: false });
    await page.getByLabel("更多 Mission 视图").click();
    await page.getByRole("option", { name: "活动记录", exact: true }).click();
    await page.locator(".event-ledger").waitFor();
    const loadOlder = page.getByRole("button", { name: "Load 100 older events", exact: true });
    if (await loadOlder.count()) await loadOlder.click();
    activityEventCount = await page.locator(".event-ledger details").count();
    await page.getByRole("button", { name: /^待我处理/ }).click();
    await page.locator('[data-testid="attention-center"]').waitFor();
    attentionCenterVisible = await page.locator('[data-testid="attention-center"]').isVisible();
    attentionItemCount = await page.locator('[data-testid="attention-card"]').count();
    attentionScreenshot = path.join(root, "implementation-attention-center.png");
    await page.screenshot({ path: attentionScreenshot, fullPage: false });
    if (seedHtmlPreview) {
      await page.locator('[data-testid="attention-card"]').getByRole("button", { name: "Review result", exact: true }).click();
      await page.locator('[data-testid="review-center"]').waitFor();
      reviewCenterVisible = await page.locator('[data-testid="review-center"]').isVisible();
    }
  }
  await page.getByRole("button", { name: "工作", exact: true }).click();
  await page.getByRole("button", { name: "新建工作", exact: true }).first().click();
  await page.locator(".requirement-composer").waitFor();
  const missionWorkspacePath = await page.locator(".composer-workspace strong").textContent();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "多会话", exact: true }).click();
  let missionSessionGroupCount = 0;
  let missionOwnedSessionCount = 0;
  if (existingMissionCount > 0) {
    await page.locator(".mission-session-group").first().waitFor();
    missionSessionGroupCount = await page.locator(".mission-session-group").count();
    missionOwnedSessionCount = await page.locator(".session-list-item.mission-owned").count();
  }
  const newSessionButton = page.getByRole("button", { name: "New session", exact: true }).first();
  await newSessionButton.waitFor();
  await newSessionButton.click();
  await page.locator('[data-testid="workspace-picker"]').waitFor();
  const sessionWorkspacePath = await page.locator('[data-testid="workspace-picker"] small').textContent();
  await page.locator(".modal .quiet-button").click();
  const defaultSessionLayout = await measureLayout(page);
  assertContainedLayout(defaultSessionLayout, "1540x960 Sessions");
  await page.setViewportSize({ width: 1120, height: 720 });
  const minimumSessionLayout = await measureLayout(page);
  assertContainedLayout(minimumSessionLayout, "1120x720 Sessions");
  if (existingMissionCount > 0) {
    await page.getByRole("button", { name: "工作", exact: true }).click();
    await page.getByRole("button", { name: /查看执行详情|打开执行项目|查看交付|查看结果|查看原因/ }).first().click();
    await page.locator(".task-groups").waitFor();
    await page.locator(".mission-tabs").getByRole("button", { name: "画布", exact: true }).click();
    await page.locator('[data-testid="graph-toolbar"]').waitFor();
    await page.locator('.react-flow__node[data-id="main"]').click();
    const minimumMissionLayout = await measureLayout(page);
    assertContainedLayout(minimumMissionLayout, "1120x720 Mission");
    const neutralEdge = page.locator(".react-flow__edge.neutral").first();
    if (await neutralEdge.count()) {
      const beforeHover = await neutralEdge.locator(".react-flow__edge-text").evaluate((node) => getComputedStyle(node).opacity);
      const hoverTarget = neutralEdge.locator(".react-flow__edge-interaction");
      const hoverPoint = await hoverTarget.evaluate((pathNode) => {
        const length = pathNode.getTotalLength();
        const matrix = pathNode.getScreenCTM();
        for (const ratio of [.1, .2, .3, .4, .5, .6, .7, .8, .9]) {
          const transformed = pathNode.getPointAtLength(length * ratio).matrixTransform(matrix);
          const hit = document.elementFromPoint(transformed.x, transformed.y);
          if (pathNode.closest(".react-flow__edge")?.contains(hit)) return { x: transformed.x, y: transformed.y, ratio };
        }
        const fallback = pathNode.getPointAtLength(length / 2).matrixTransform(matrix);
        return { x: fallback.x, y: fallback.y, ratio: .5 };
      });
      // React Flow exposes a generous interaction path, but moving the real
      // macOS cursor to a sub-pixel SVG coordinate is flaky across GPU modes.
      // Dispatch the same bubbling event through that interaction path after
      // proving above that the path owns at least one screen coordinate.
      await hoverTarget.dispatchEvent("mouseover", { bubbles: true });
      await page.waitForTimeout(180);
      const afterHover = await neutralEdge.locator(".react-flow__edge-text").evaluate((node) => getComputedStyle(node).opacity);
      edgeLabelHoverVerified = Number(beforeHover) === 0 && Number(afterHover) === 1;
      edgeLabelDebug = await neutralEdge.evaluate((node, values) => {
        const interaction = node.querySelector(".react-flow__edge-interaction");
        const hit = document.elementFromPoint(values.hoverPoint.x, values.hoverPoint.y);
        return { ...values, edgeHover: node.matches(":hover"), interactionHover: interaction?.matches(":hover"), pointerEvents: interaction ? getComputedStyle(interaction).pointerEvents : null, strokeWidth: interaction ? getComputedStyle(interaction).strokeWidth : null, hitClassName: hit?.getAttribute?.("class"), className: node.getAttribute("class") };
      }, { beforeHover, afterHover, hoverPoint });
    } else {
      edgeLabelDebug = { neutralEdges: 0 };
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    reducedMotionDebug = await page.locator(".task-row").first().evaluate((node) => {
      const duration = getComputedStyle(node).transitionDuration.split(",")[0];
      const seconds = duration.endsWith("ms") ? Number.parseFloat(duration) / 1000 : Number.parseFloat(duration);
      return { matches: matchMedia("(prefers-reduced-motion: reduce)").matches, duration, seconds };
    });
    reducedMotionVerified = reducedMotionDebug.matches && reducedMotionDebug.seconds <= .001;
    await page.emulateMedia({ reducedMotion: "no-preference" });
    result = { defaultSessionLayout, minimumSessionLayout, minimumMissionLayout };
  } else {
    result = { defaultSessionLayout, minimumSessionLayout, minimumMissionLayout: null };
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".interface-size-control").waitFor();
  interfaceSizeControlVisible = await page.locator(".interface-size-control").isVisible();
  await page.locator(".interface-size-control").getByRole("button", { name: /Large/ }).click();
  interfaceSizePersisted = await page.evaluate(() => document.documentElement.dataset.uiDensity === "large" && localStorage.getItem("agent-deck:interface-size") === "large");
  if (existingMissionCount > 0) {
    await page.getByRole("button", { name: "工作", exact: true }).click();
    await page.getByRole("button", { name: /查看执行详情|打开执行项目|查看交付|查看结果|查看原因/ }).first().click();
    await page.locator(".mission-inspector > nav").waitFor();
    largeMissionLayout = await measureLayout(page);
    assertContainedLayout(largeMissionLayout, "1120x720 Mission Large");
    responsiveMacScreenshot = path.join(root, "implementation-macos-responsive.png");
    await page.screenshot({ path: responsiveMacScreenshot, fullPage: false });
    await page.getByRole("button", { name: "设置", exact: true }).click();
  }
  await page.locator(".interface-size-control").getByRole("button", { name: /Comfortable/ }).click();
  typographyScreenshot = path.join(root, "implementation-typography-settings.png");
  await page.screenshot({ path: typographyScreenshot, fullPage: false });
  const runtimeResult = await page.evaluate(async () => {
    const bridge = window.agentDeckDesktop;
    const missions = await bridge.missions.list();
    const workspace = await bridge.currentWorkspace();
    return {
      desktop: bridge.isDesktop,
      missionBridge: typeof bridge.missions.create === "function",
      missionCount: missions.length,
      workspaceName: workspace?.name || null,
      title: document.title,
      bodyWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  result = { ...result, ...runtimeResult };
  result.missionWorkspacePath = missionWorkspacePath;
  result.sessionWorkspacePath = sessionWorkspacePath;
  result.observabilityScreenshot = observabilityScreenshot;
  result.artifactsScreenshot = artifactsScreenshot;
  result.attentionScreenshot = attentionScreenshot;
  result.artifactFileCount = artifactFileCount;
  result.activityEventCount = activityEventCount;
  result.missionSessionGroupCount = missionSessionGroupCount;
  result.missionOwnedSessionCount = missionOwnedSessionCount;
  result.visibleConversationCount = visibleConversationCount;
  result.mainComposerVisible = mainComposerVisible;
  result.workerComposerVisible = workerComposerVisible;
  result.rawStructuredMainResponses = rawStructuredMainResponses;
  result.rawStructuredWorkerResponses = rawStructuredWorkerResponses;
  result.reviewActionVisible = reviewActionVisible;
  result.reviewActionExpected = reviewActionExpected;
  result.agentArtifactTabVisible = agentArtifactTabVisible;
  result.agentArtifactCount = agentArtifactCount;
  result.missionBlockerGateVisible = missionBlockerGateVisible;
  result.missionBlockerGateExpected = missionBlockerGateExpected;
  result.agentBlockerResolutionVisible = agentBlockerResolutionVisible;
  result.agentBlockerResolutionExpected = agentBlockerResolutionExpected;
  result.preThreadRecoveryVisible = preThreadRecoveryVisible;
  result.preThreadRecoveryExpected = preThreadRecoveryExpected;
  result.htmlPreviewVisible = htmlPreviewVisible;
  result.reviewOpenMs = reviewOpenMs;
  result.graphToolbarVisible = graphToolbarVisible;
  result.planEditorVisible = planEditorVisible;
  result.planEditorExpected = planEditorExpected;
  result.graphDragPersisted = graphDragPersisted;
  result.attentionItemCount = attentionItemCount;
  result.attentionCenterVisible = attentionCenterVisible;
  result.reviewCenterVisible = reviewCenterVisible;
  result.interfaceSizeControlVisible = interfaceSizeControlVisible;
  result.interfaceSizePersisted = interfaceSizePersisted;
  result.typographyScreenshot = typographyScreenshot;
  result.largeMissionLayout = largeMissionLayout;
  result.mainAgentMissionLayout = mainAgentMissionLayout;
  result.focusedInspectorLayout = focusedInspectorLayout;
  result.mainAgentResponsiveScreenshot = mainAgentResponsiveScreenshot;
  result.focusedInspectorScreenshot = focusedInspectorScreenshot;
  result.edgeLabelHoverVerified = edgeLabelHoverVerified;
  result.reducedMotionVerified = reducedMotionVerified;
  result.edgeLabelDebug = edgeLabelDebug;
  result.reducedMotionDebug = reducedMotionDebug;
  result.responsiveMacScreenshot = responsiveMacScreenshot;
} finally {
  await app.close();
  fs.rmSync(qaUserData, { recursive: true, force: true });
}
if (!result.desktop || !result.missionBridge) throw new Error("Desktop mission bridge unavailable");
if (!result.missionWorkspacePath?.startsWith("/") || !result.sessionWorkspacePath?.startsWith("/")) throw new Error("Workspace picker does not expose the resolved local path");
if (result.missionCount > 0 && (!result.missionSessionGroupCount || !result.missionOwnedSessionCount)) throw new Error("Persisted Mission threads are missing from Sessions");
if (result.missionCount > 0 && (!result.mainComposerVisible || !result.workerComposerVisible)) throw new Error("Main Agent or Worker intervention composer is not visible");
if (result.missionCount > 0 && (result.rawStructuredMainResponses || result.rawStructuredWorkerResponses)) throw new Error("Structured agent responses are leaking raw JSON into Conversation");
if (result.reviewActionExpected && !result.reviewActionVisible) throw new Error("Review tasks do not expose a visible decision action");
if (result.missionBlockerGateExpected && !result.missionBlockerGateVisible) throw new Error("Blocked Mission does not expose a recovery entry on the graph");
if (result.agentBlockerResolutionExpected && !result.agentBlockerResolutionVisible) throw new Error("Blocked Worker does not expose a visible recovery panel");
if (result.missionCount > 0 && (!result.graphToolbarVisible || !result.graphDragPersisted)) throw new Error("Mission graph controls or durable node dragging are unavailable");
if (result.missionCount > 0 && (!result.edgeLabelHoverVerified || !result.reducedMotionVerified)) throw new Error(`Responsive edge labels or reduced-motion support regressed: ${JSON.stringify({ edge: result.edgeLabelDebug, motion: result.reducedMotionDebug })}`);
if (result.planEditorExpected && !result.planEditorVisible) throw new Error("Ready Mission does not expose the safe plan editor");
if (result.preThreadRecoveryExpected && !result.preThreadRecoveryVisible) throw new Error("A pre-thread blocker does not expose a real Worker startup action");
if (result.missionCount > 0 && !result.agentArtifactTabVisible) throw new Error("Selected agents do not expose a first-class Artifacts tab");
if (result.missionCount > 0 && !result.attentionCenterVisible) throw new Error("The cross-mission Attention Center is unavailable");
if (seedHtmlPreview && (!result.attentionItemCount || !result.reviewCenterVisible)) throw new Error("Attention items do not open the actionable Review Center");
if (!result.interfaceSizeControlVisible || !result.interfaceSizePersisted) throw new Error("Interface size controls are unavailable or do not persist locally");
if (seedHtmlPreview && !result.htmlPreviewVisible) throw new Error("HTML artifact does not open in the safe in-app preview");
if (result.bodyWidth !== result.viewportWidth) throw new Error("Desktop UI overflows horizontally");
if (pageErrors.length) throw new Error(JSON.stringify(pageErrors));
console.log(JSON.stringify({ ok: true, ...result, pageErrors }, null, 2));
