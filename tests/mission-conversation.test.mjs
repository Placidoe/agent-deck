import assert from "node:assert/strict";
import test from "node:test";
import { agentConversationContent, conversationFromThread } from "../src/mission-conversation.js";

test("conversation projection inspects only the latest 24 turns", () => {
  const turns = Array.from({ length: 5_000 }, (_, index) => {
    if (index < 4_976) {
      const turn = { id: `old-${index}` };
      Object.defineProperty(turn, "items", {
        get() { throw new Error("historical turn should not be inspected"); },
      });
      return turn;
    }
    return {
      id: `recent-${index}`,
      items: [
        { id: `u-${index}`, type: "userMessage", text: `request-${index}` },
        { id: `a-${index}`, type: "agentMessage", text: `response-${index}` },
      ],
    };
  });

  const entries = conversationFromThread({ turns });
  assert.equal(entries.length, 48);
  assert.equal(entries[0].text, "request-4976");
  assert.equal(entries.at(-1).text, "response-4999");
});

test("structured worker result is projected into review-friendly fields", () => {
  const projected = agentConversationContent({
    text: JSON.stringify({
      summary: "Implemented and verified.",
      acceptance: [{ criterion: "Tests pass", passed: true, evidence: "19/19" }],
      changedFiles: ["src/view.jsx"],
      blockers: [],
    }),
  });

  assert.equal(projected.text, "Implemented and verified.");
  assert.equal(projected.structuredResult.acceptance[0].passed, true);
  assert.deepEqual(projected.structuredResult.changedFiles, ["src/view.jsx"]);
});

test("huge responses bypass synchronous structured parsing", () => {
  const huge = `${JSON.stringify({ summary: "x" })}${" ".repeat(512_001)}`;
  const projected = agentConversationContent({ text: huge });
  assert.equal(projected.text, huge);
  assert.equal(projected.structuredResult, undefined);
});
