const NODE_WIDTH = 212;
const NODE_HEIGHT = 88;

export function validateMissionDag(tasks = []) {
  const keys = new Set(tasks.map((task) => task.key));
  const missing = [];
  const selfDependencies = [];
  const adjacency = new Map(tasks.map((task) => [task.key, []]));
  for (const task of tasks) {
    for (const dependency of task.dependencies || []) {
      if (dependency === task.key) selfDependencies.push(task.key);
      else if (!keys.has(dependency)) missing.push({ task: task.key, dependency });
      else adjacency.get(dependency).push(task.key);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(key, path = []) {
    if (visiting.has(key)) {
      const start = path.indexOf(key);
      cycles.push([...path.slice(start), key]);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const child of adjacency.get(key) || []) visit(child, [...path, key]);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of keys) visit(key);
  return { valid: !missing.length && !selfDependencies.length && !cycles.length, missing, selfDependencies, cycles };
}

export function autoLayoutMission(tasks = [], mode = "horizontal") {
  const positions = { main: { x: 40, y: 40 } };
  if (!tasks.length) return positions;
  if (mode === "compact") {
    tasks.forEach((task, index) => {
      positions[task.key] = { x: 40 + (index % 3) * (NODE_WIDTH + 54), y: 190 + Math.floor(index / 3) * (NODE_HEIGHT + 58) };
    });
    return positions;
  }
  const rank = new Map();
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  function resolve(key, trail = new Set()) {
    if (rank.has(key)) return rank.get(key);
    if (trail.has(key)) return 1;
    trail.add(key);
    const task = byKey.get(key);
    const dependencies = (task?.dependencies || []).filter((dependency) => byKey.has(dependency));
    const value = dependencies.length ? Math.max(...dependencies.map((dependency) => resolve(dependency, new Set(trail)))) + 1 : 1;
    rank.set(key, value);
    return value;
  }
  tasks.forEach((task) => resolve(task.key));
  const lanes = new Map();
  for (const task of tasks) {
    const depth = rank.get(task.key) || 1;
    if (!lanes.has(depth)) lanes.set(depth, []);
    lanes.get(depth).push(task);
  }
  if (mode === "vertical") {
    positions.main = { x: 340, y: 30 };
    for (const [depth, lane] of lanes) {
      const span = (lane.length - 1) * (NODE_WIDTH + 50);
      lane.forEach((task, index) => { positions[task.key] = { x: 340 - span / 2 + index * (NODE_WIDTH + 50), y: 30 + depth * 180 }; });
    }
  } else {
    positions.main = { x: 30, y: 260 };
    for (const [depth, lane] of lanes) {
      const span = (lane.length - 1) * (NODE_HEIGHT + 48);
      lane.forEach((task, index) => { positions[task.key] = { x: 30 + depth * 290, y: 260 - span / 2 + index * (NODE_HEIGHT + 48) }; });
    }
  }
  return positions;
}

export function missionPath(tasks = [], selectedKey) {
  if (!selectedKey) return { nodes: new Set(), edges: new Set() };
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const children = new Map(tasks.map((task) => [task.key, []]));
  for (const task of tasks) for (const dependency of task.dependencies || []) children.get(dependency)?.push(task.key);
  const nodes = new Set([selectedKey]);
  const edges = new Set();
  function upstream(key) {
    for (const dependency of byKey.get(key)?.dependencies || []) {
      nodes.add(dependency); edges.add(`${dependency}->${key}`); upstream(dependency);
    }
  }
  function downstream(key) {
    for (const child of children.get(key) || []) {
      nodes.add(child); edges.add(`${key}->${child}`); downstream(child);
    }
  }
  upstream(selectedKey); downstream(selectedKey);
  return { nodes, edges };
}

// In the absence of observed duration estimates, the longest dependency chain
// is the honest scheduling proxy. It is deliberately not presented as a time
// forecast; it simply marks the chain with the most ordered hand-offs.
export function criticalMissionPath(tasks = []) {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const memo = new Map();
  function resolve(key, visiting = new Set()) {
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return [key];
    const nextVisiting = new Set(visiting); nextVisiting.add(key);
    const dependencies = (byKey.get(key)?.dependencies || []).filter((dependency) => byKey.has(dependency));
    const longest = dependencies.map((dependency) => resolve(dependency, nextVisiting)).sort((left, right) => right.length - left.length)[0] || [];
    const path = [...longest, key]; memo.set(key, path); return path;
  }
  const path = tasks.map((task) => resolve(task.key)).sort((left, right) => right.length - left.length)[0] || [];
  return { keys: path, nodes: new Set(path), edges: new Set(path.slice(1).map((key, index) => `${path[index]}->${key}`)) };
}

export function dependencyImpact(tasks = [], selectedKey) {
  if (!selectedKey) return { upstream: [], downstream: [], pendingDownstream: [] };
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const children = new Map(tasks.map((task) => [task.key, []]));
  for (const task of tasks) for (const dependency of task.dependencies || []) children.get(dependency)?.push(task.key);
  const visit = (initial, next) => {
    const seen = new Set();
    const walk = (key) => { for (const entry of next(key) || []) if (!seen.has(entry)) { seen.add(entry); walk(entry); } };
    walk(initial); return [...seen];
  };
  const upstream = visit(selectedKey, (key) => byKey.get(key)?.dependencies || []);
  const downstream = visit(selectedKey, (key) => children.get(key) || []);
  return { upstream, downstream, pendingDownstream: downstream.filter((key) => !["completed", "canceled"].includes(byKey.get(key)?.status)) };
}

export function planImpact(previousTasks = [], nextTasks = []) {
  const previous = new Map(previousTasks.map((task) => [task.key, task]));
  const next = new Map(nextTasks.map((task) => [task.key, task]));
  const added = nextTasks.filter((task) => !previous.has(task.key)).map((task) => task.key);
  const removed = previousTasks.filter((task) => !next.has(task.key)).map((task) => task.key);
  const changed = nextTasks.filter((task) => {
    const before = previous.get(task.key);
    return before && JSON.stringify([before.title, before.description, before.agentRole, before.dependencies, before.acceptanceCriteria]) !== JSON.stringify([task.title, task.description, task.agentRole, task.dependencies, task.acceptanceCriteria]);
  }).map((task) => task.key);
  return { added, removed, changed, total: added.length + removed.length + changed.length };
}
