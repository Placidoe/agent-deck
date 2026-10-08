import test from "node:test";
import assert from "node:assert/strict";
import { THEMES, THEME_KEY, readTheme, resolveTheme, applyTheme, saveTheme } from "../src/appearance.js";
import { avatarTone } from "../src/agent-identity.js";

function luminance(hex) {
  const channels = hex.match(/[a-f0-9]{2}/gi).map(n => parseInt(n,16)/255).map(n => n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4);
  return channels[0]*.2126 + channels[1]*.7152 + channels[2]*.0722;
}
function contrast(a,b) { const values = [luminance(a),luminance(b)].sort((x,y) => y-x); return (values[0]+.05)/(values[1]+.05); }
test("every accent has readable normal/hover primary buttons and highlighted text", () => {
  assert.equal(new Set(THEMES.map(t => t.id)).size, THEMES.length);
  for (const t of THEMES) {
    assert.ok(contrast(t.solid,"#ffffff") >= 4.5, `${t.id} button contrast`);
    assert.ok(contrast(t.hover,"#ffffff") >= 4.5, `${t.id} hover contrast`);
    assert.ok(contrast(t.accent,"#20252d") >= 4.5, `${t.id} text contrast`);
  }
});
test("saved theme round-trips and unknown/blocked storage falls back safely", () => {
  const map = new Map(); const storage = { getItem: key => map.get(key), setItem: (key,value) => map.set(key,value) };
  assert.equal(readTheme(storage), "blue");
  assert.equal(saveTheme("iris",storage), true);
  assert.equal(map.get(THEME_KEY), "iris"); assert.equal(readTheme(storage), "iris");
  map.set(THEME_KEY,"unknown"); assert.equal(readTheme(storage),"blue");
  const blocked = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("full"); } };
  assert.equal(readTheme(blocked),"blue"); assert.equal(saveTheme("rose",blocked),false);
  assert.equal(saveTheme("rose",null),false);
});
test("theme application changes only three presentation tokens, not runtime or status", () => {
  const values = new Map([["--green","#66d07b"],["--amber","#efaf32"],["--red","#ef665d"]]);
  const root = { dataset: { runtimeMode: "agent_deck" }, style: { setProperty: (key,value) => values.set(key,value) } };
  assert.equal(applyTheme("teal", root), "teal");
  assert.equal(root.dataset.runtimeMode,"agent_deck"); assert.equal(root.dataset.accentTheme,"teal");
  assert.equal(values.get("--accent"),resolveTheme("teal").accent); assert.equal(values.size,6);
  assert.equal(values.get("--green"),"#66d07b"); assert.equal(values.get("--amber"),"#efaf32");
  assert.equal(applyTheme("nonsense",root),"blue");
});
test("Chinese/English role identity is stable and explicit user/main flags win", () => {
  for (const [role,tone] of [["主 Agent","main"],["Planner","main"],["研究员","researcher"],["需求分析师","researcher"],["Research worker","researcher"],["架构师","architect"],["Architect","architect"],["质量审核员","reviewer"],["Security reviewer","reviewer"],["报告工程师","builder"]]) assert.equal(avatarTone({ role }),tone,role);
  assert.equal(avatarTone({ role: "researcher", main: true }),"main");
  assert.equal(avatarTone({ role: "Planner", main: true, user: true }),"you");
  assert.equal(avatarTone(),"builder");
});
