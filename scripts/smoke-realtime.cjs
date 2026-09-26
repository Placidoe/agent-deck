const { app, BrowserWindow } = require("electron");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");

const codex = new CodexAppServer();
let window;

function waitForRealtime(threadId) {
  let started = false;
  let answered = false;
  let settle;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Realtime WebRTC handshake timed out")), 45000);
    settle = () => {
      if (!started || !answered) return;
      clearTimeout(timeout);
      resolve();
    };
    codex.on("event", async (event) => {
      if (event.params?.threadId !== threadId) return;
      if (event.method === "thread/realtime/error") {
        clearTimeout(timeout);
        reject(new Error(event.params.message));
      }
      if (event.method === "thread/realtime/started") {
        started = true;
        settle();
      }
      if (event.method === "thread/realtime/sdp") {
        await window.webContents.executeJavaScript(`window.peer.setRemoteDescription({ type: "answer", sdp: ${JSON.stringify(event.params.sdp)} })`);
        answered = true;
        settle();
      }
    });
  });
  return ready;
}

async function createOffer() {
  await window.loadURL("data:text/html,<title>Agent Deck Realtime Smoke</title>");
  return window.webContents.executeJavaScript(`(async () => {
    window.peer = new RTCPeerConnection();
    window.peer.addTransceiver("audio", { direction: "sendrecv" });
    window.peer.createDataChannel("oai-events");
    const offer = await window.peer.createOffer();
    await window.peer.setLocalDescription(offer);
    if (window.peer.iceGatheringState !== "complete") {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        window.peer.addEventListener("icegatheringstatechange", () => {
          if (window.peer.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    }
    return window.peer.localDescription.sdp;
  })()`);
}

app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false } });
    const sdp = await createOffer();
    await codex.start();
    const created = await codex.request("thread/start", {
      cwd: process.cwd(),
      ephemeral: true,
      historyMode: "legacy",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "agent_deck_realtime_smoke",
    });
    const threadId = created.thread.id;
    const ready = waitForRealtime(threadId);
    await codex.request("thread/realtime/start", {
      threadId,
      outputModality: "audio",
      version: "v3",
      includeStartupContext: true,
      transport: { type: "webrtc", sdp },
    }, 45000);
    await ready;
    await codex.request("thread/realtime/stop", { threadId }, 15000);
    console.log(JSON.stringify({ ok: true, threadId, transport: "webrtc" }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    codex.stop();
    window?.destroy();
    app.quit();
  }
});
