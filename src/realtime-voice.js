const defaultState = { status: "idle", threadId: null, message: "" };

function waitForIceGathering(peer, timeoutMs = 5000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

export class RealtimeVoiceController {
  constructor({ api, mediaDevices, PeerConnection, createAudio, onState }) {
    this.api = api;
    this.mediaDevices = mediaDevices;
    this.PeerConnection = PeerConnection;
    this.createAudio = createAudio;
    this.onState = onState;
    this.active = null;
    this.operation = Promise.resolve();
  }

  emit(patch) {
    this.onState?.({ ...defaultState, ...patch });
  }

  async start({ threadId, cwd }) {
    this.operation = this.operation.catch(() => {}).then(() => this.#start({ threadId, cwd }));
    return this.operation;
  }

  async #start({ threadId, cwd }) {
    if (!threadId) throw new Error("Select a Codex session before starting voice.");
    if (this.active?.threadId === threadId) return;
    if (this.active) await this.#stop(true);

    this.emit({ status: "connecting", threadId, message: "正在请求麦克风…" });
    const permitted = await this.api.requestMicrophone();
    if (!permitted) {
      const error = new Error("麦克风权限未开启，请在系统设置 → 隐私与安全性 → 麦克风中允许 Agent Deck。");
      this.emit({ status: "error", threadId, message: error.message });
      throw error;
    }

    let stream;
    let peer;
    try {
      stream = await this.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      peer = new this.PeerConnection();
      const audio = this.createAudio();
      audio.autoplay = true;
      audio.playsInline = true;
      const events = peer.createDataChannel("oai-events");
      this.active = { threadId, stream, peer, audio, events, stopping: false };

      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      peer.ontrack = (event) => {
        audio.srcObject = event.streams?.[0] || new MediaStream([event.track]);
        audio.play().catch(() => {});
      };
      peer.onconnectionstatechange = () => {
        if (!this.active || this.active.peer !== peer) return;
        if (peer.connectionState === "connected") this.emit({ status: "listening", threadId, message: "可以直接说话" });
        if (["failed", "disconnected"].includes(peer.connectionState)) {
          this.emit({ status: "error", threadId, message: `语音连接${peer.connectionState === "failed" ? "失败" : "已断开"}` });
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Could not create a WebRTC offer.");
      this.emit({ status: "connecting", threadId, message: "正在连接 Codex 实时语音…" });
      await this.api.startRealtime({ threadId, cwd, sdp });
    } catch (error) {
      if (this.active?.peer === peer) await this.#stop(false);
      else stream?.getTracks().forEach((track) => track.stop());
      this.emit({ status: "error", threadId, message: error.message || String(error) });
      throw error;
    }
  }

  async stop() {
    this.operation = this.operation.catch(() => {}).then(() => this.#stop(true));
    return this.operation;
  }

  async #stop(notifyServer) {
    const current = this.active;
    if (!current || current.stopping) {
      this.emit(defaultState);
      return;
    }
    current.stopping = true;
    this.emit({ status: "stopping", threadId: current.threadId, message: "正在结束语音…" });
    try {
      if (notifyServer) await this.api.stopRealtime({ threadId: current.threadId });
    } catch {
      // Local media must always be released even if the remote session has closed.
    } finally {
      current.stream.getTracks().forEach((track) => track.stop());
      current.events?.close();
      current.peer.close();
      current.audio.pause();
      current.audio.srcObject = null;
      if (this.active === current) this.active = null;
      this.emit(defaultState);
    }
  }

  async handleCodexEvent(event) {
    const current = this.active;
    const params = event?.params || {};
    if (!current || params.threadId !== current.threadId) return;

    if (event.method === "thread/realtime/sdp") {
      await current.peer.setRemoteDescription({ type: "answer", sdp: params.sdp });
      this.emit({ status: "connecting", threadId: current.threadId, message: "正在建立音频通道…" });
    } else if (event.method === "thread/realtime/started") {
      this.emit({ status: "listening", threadId: current.threadId, message: "可以直接说话" });
    } else if (event.method === "thread/realtime/transcript/delta") {
      this.emit({
        status: params.role === "assistant" ? "speaking" : "listening",
        threadId: current.threadId,
        message: params.role === "assistant" ? "Codex 正在回答" : "正在听你说话",
      });
    } else if (event.method === "thread/realtime/transcript/done") {
      this.emit({ status: "listening", threadId: current.threadId, message: "可以继续说话" });
    } else if (event.method === "thread/realtime/error") {
      this.emit({ status: "error", threadId: current.threadId, message: params.message || "实时语音发生错误" });
    } else if (event.method === "thread/realtime/closed") {
      await this.#stop(false);
    }
  }
}

export function createBrowserVoiceController(desktop, onState) {
  return new RealtimeVoiceController({
    api: {
      requestMicrophone: () => desktop.media.requestMicrophone(),
      startRealtime: (input) => desktop.codex.startRealtime(input),
      stopRealtime: (input) => desktop.codex.stopRealtime(input),
    },
    mediaDevices: navigator.mediaDevices,
    PeerConnection: window.RTCPeerConnection,
    createAudio: () => document.createElement("audio"),
    onState,
  });
}
