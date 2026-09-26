import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeVoiceController } from "../src/realtime-voice.js";

class FakePeerConnection {
  constructor() {
    this.iceGatheringState = "complete";
    this.connectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
  }
  createDataChannel() { return { close() {} }; }
  addTrack() {}
  async createOffer() { return { type: "offer", sdp: "fake-offer" }; }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription(answer) { this.remoteDescription = answer; }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
}

function fixture({ permission = true } = {}) {
  const calls = [];
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track] };
  const states = [];
  const audio = { srcObject: null, autoplay: false, playsInline: false, play: async () => {}, pause() {} };
  const controller = new RealtimeVoiceController({
    api: {
      requestMicrophone: async () => permission,
      startRealtime: async (input) => calls.push(["start", input]),
      stopRealtime: async (input) => calls.push(["stop", input]),
    },
    mediaDevices: { getUserMedia: async () => stream },
    PeerConnection: FakePeerConnection,
    createAudio: () => audio,
    onState: (state) => states.push(state),
  });
  return { controller, calls, states, track };
}

test("negotiates and releases a Codex realtime voice session", async () => {
  const { controller, calls, states, track } = fixture();
  await controller.start({ threadId: "thread-1", cwd: "/repo" });
  assert.deepEqual(calls[0], ["start", { threadId: "thread-1", cwd: "/repo", sdp: "fake-offer" }]);

  await controller.handleCodexEvent({ method: "thread/realtime/sdp", params: { threadId: "thread-1", sdp: "fake-answer" } });
  assert.equal(controller.active.peer.remoteDescription.sdp, "fake-answer");
  await controller.handleCodexEvent({ method: "thread/realtime/started", params: { threadId: "thread-1" } });
  assert.equal(states.at(-1).status, "listening");

  await controller.stop();
  assert.deepEqual(calls.at(-1), ["stop", { threadId: "thread-1" }]);
  assert.equal(track.stopped, true);
  assert.equal(states.at(-1).status, "idle");
});

test("does not open media when microphone permission is denied", async () => {
  const { controller, calls, states } = fixture({ permission: false });
  await assert.rejects(controller.start({ threadId: "thread-1", cwd: "/repo" }), /麦克风权限未开启/);
  assert.equal(calls.length, 0);
  assert.equal(states.at(-1).status, "error");
  await controller.stop();
  assert.equal(states.at(-1).status, "idle");
});
