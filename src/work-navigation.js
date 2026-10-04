// Read-only projections. Navigation never creates duplicate tasks or execution state.
export function productSection(view) {
  if (view === "attention") return "attention";
  if (["results", "artifacts"].includes(view)) return "results";
  if (view === "settings") return "settings";
  return "work";
}

const missionStatuses = {
  planning: "planning", ready: "awaiting_approval", running: "running", review: "review",
  ready_to_integrate: "review", integrating: "running", completed: "done", canceled: "archived",
  blocked: "blocked", failed: "blocked", integration_conflict: "blocked",
};

export function collectWork(requirements = [], missions = [], workspacePath) {
  const linked = new Set(requirements.map(item => item.missionId).filter(Boolean));
  const byId = new Map(missions.map(item => [item.id, item]));
  const rows = requirements.map(item => {
    const mission = byId.get(item.missionId);
    return { ...item, workSource: "requirement", status: mission ? missionStatuses[mission.status] || item.status : item.status,
      executionWorkspace: mission?.cwd, counts: mission?.counts };
  });
  for (const mission of missions) {
    if (linked.has(mission.id) || (workspacePath && mission.cwd !== workspacePath)) continue;
    rows.push({ id: `mission:${mission.id}`, missionId: mission.id, missionTitle: mission.title,
      projectId: mission.projectId || null,
      title: mission.title, outcome: mission.outcome, body: "", status: missionStatuses[mission.status] || "blocked",
      priority: "medium", updatedAt: mission.updatedAt, createdAt: mission.createdAt, workspacePath: mission.cwd,
      executionWorkspace: mission.cwd, counts: mission.counts, tokenBudget: mission.tokenBudget, workSource: "mission" });
  }
  return rows;
}

export function outcomeGroups(missions = [], query = "") {
  const search = query.trim().toLocaleLowerCase();
  return missions.filter(item => Number(item.counts?.artifacts) > 0 && (!search || `${item.title} ${item.outcome} ${item.cwd}`.toLocaleLowerCase().includes(search)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
