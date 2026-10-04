const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.AGENT_DECK_EVAL_QA_PROFILE);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1540, height: 960, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadFile(process.env.AGENT_DECK_EVAL_QA_DOCUMENT);
});
app.on("window-all-closed", () => app.quit());
