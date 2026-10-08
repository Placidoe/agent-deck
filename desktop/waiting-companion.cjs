// Local, read-only companion. Never schedules, approves or interrupts agent work.
const { randomUUID } = require("node:crypto");
const activities = new Set(["quiet", "move", "work", "away"]);
const durations = new Set([0, 3, 5, 10, 20]);
const terminal = new Set(["review", "ready_to_integrate", "completed", "canceled", "ready"]);

function changes(baseline, current) {
  const byId = new Map(current.map(row => [row.id, row]));
  return baseline.map(before => {
    const after = byId.get(before.id);
    if (!after) return { ...before, missing: true, newCompleted: 0, newArtifacts: 0 };
    return { ...after, newCompleted: Math.max(0, after.completed - before.completed), newArtifacts: Math.max(0, after.artifacts - before.artifacts) };
  });
}

class WaitingCompanion {
  constructor({ store, notify = () => false, now = Date.now }) { this.store = store; this.notify = notify; this.now = now; this.session = null; this.seen = new Set(); }
  read() {
    const active = this.store.waitingWork();
    const session = this.session && { ...this.session, changes: changes(this.session.baseline, this.store.waitingWork(this.session.baseline.map(row => row.id))), baseline: undefined };
    return { source: "local-ledger", active, session, notifications: this.notificationStatus || "not-requested" };
  }
  start(input = {}) {
    if (this.session) throw new Error("已有一段个人时间，请先结束或回来查看。");
    if (!activities.has(input.activity) || !durations.has(input.minutes) || !["notify", "return"].includes(input.reminders) || typeof input.criticalReminders !== "boolean") throw new Error("请选择有效的活动、时长和提醒方式。");
    const baseline = this.store.waitingWork();
    if (!baseline.length) throw new Error("当前没有正在执行的 Agent Deck 工作；不会模拟等待或启动新任务。");
    const startedAt = this.now();
    this.session = { id: randomUUID(), activity: input.activity, minutes: input.minutes, reminders: input.reminders, criticalReminders: input.criticalReminders, startedAt, deadline: input.minutes ? startedAt + input.minutes * 60_000 : null, baseline };
    this.seen = new Set(baseline.flatMap(row => this.signals(row)));
    this.notificationStatus = "not-requested";
    return this.read();
  }
  signals(row) {
    return [...row.critical.map(key => `critical:${row.id}:${key}`), ...(terminal.has(row.status) ? [`routine:${row.id}:${row.status}`] : [])];
  }
  update() {
    if (!this.session) return;
    const rows = this.store.waitingWork(this.session.baseline.map(row => row.id));
    const fresh = rows.flatMap(row => this.signals(row)).filter(key => !this.seen.has(key));
    fresh.forEach(key => this.seen.add(key));
    const critical = fresh.some(key => key.startsWith("critical:"));
    const routine = fresh.some(key => key.startsWith("routine:"));
    if (!(critical && this.session.criticalReminders) && !(routine && this.session.reminders === "notify")) return;
    try {
      // Generic body deliberately contains no user task titles or private paths.
      this.notificationStatus = this.notify({ critical: critical && this.session.criticalReminders }) ? "requested" : "unavailable";
    } catch { this.notificationStatus = "unavailable"; }
  }
  finish(id) {
    if (!this.session || id !== this.session.id) throw new Error("这段个人时间已经结束，请刷新查看。");
    const result = this.read(); this.session = null; this.seen.clear();
    return { ...result, session: { ...result.session, endedAt: this.now() } };
  }
}
module.exports = { WaitingCompanion, changes };
