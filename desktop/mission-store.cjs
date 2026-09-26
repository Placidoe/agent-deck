const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { decodeGitPath } = require("./path-utils.cjs");
const { assertMissionState, assertTaskState } = require("./mission-state.cjs");

let BetterSqlite3 = null;
try { BetterSqlite3 = require("better-sqlite3"); } catch { BetterSqlite3 = null; }

const SQLITE_MAX_BUFFER = 32 * 1024 * 1024;

function quote(value) {
  if (value == null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return quote(JSON.stringify(value ?? null));
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function compactText(value, limit = 1400) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function estimateTokens(value) {
  const text = String(value || "");
  // This is deliberately labelled as an estimate in the UI. It is stable across
  // providers and avoids pretending to know a model-specific tokenizer locally.
  let units = 0;
  for (const character of text) units += /[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 0.78 : 0.26;
  return Math.max(1, Math.ceil(units));
}

function numberInRange(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function normalizeValueContract(input = {}) {
  return {
    scenario: String(input.scenario || "研发交付").trim().slice(0, 80) || "研发交付",
    valueType: ["time_saved", "revenue", "risk_avoided", "decision_speed", "knowledge_reuse"].includes(input.valueType) ? input.valueType : "time_saved",
    owner: String(input.owner || "").trim().slice(0, 80),
    targetMetric: String(input.targetMetric || "").trim().slice(0, 180),
    expectedValueCny: numberInRange(input.expectedValueCny, 0, 0, 100000000),
    baselineHours: numberInRange(input.baselineHours, 0, 0, 100000),
    humanHourlyRateCny: numberInRange(input.humanHourlyRateCny, 300, 0, 100000),
    tokenBudget: Math.round(numberInRange(input.tokenBudget, 80000, 1000, 5000000)),
    tokenCostPer1kCny: numberInRange(input.tokenCostPer1kCny, 0.02, 0, 1000),
    deadline: String(input.deadline || "").trim().slice(0, 40),
  };
}

function trajectoryText(node) {
  return [node.title, node.summary, node.ref, node.filePath, node.content].filter(Boolean).join("\n");
}

class MissionStore {
  constructor(databasePath, options = {}) {
    this.databasePath = databasePath;
    this.sqliteBinary = options.sqliteBinary || "/usr/bin/sqlite3";
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = null;
    if (BetterSqlite3) {
      try { this.database = new BetterSqlite3(databasePath); } catch { this.database = null; }
    }
    if (this.database) {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
    }
    this.#exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        outcome TEXT NOT NULL,
        source_prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'codex',
        model TEXT,
        status TEXT NOT NULL,
        max_workers INTEGER NOT NULL DEFAULT 4,
        main_thread_id TEXT,
        active_turn_id TEXT,
        spec_json TEXT,
        value_contract_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        result_json TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        agent_thread_id TEXT,
        active_turn_id TEXT,
        worktree_path TEXT,
        branch TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(mission_id, task_key)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(agent_thread_id);
      CREATE TABLE IF NOT EXISTS mission_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT,
        thread_id TEXT,
        event_type TEXT NOT NULL,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_mission ON mission_events(mission_id, seq DESC);
      CREATE TABLE IF NOT EXISTS bus_messages (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        topic TEXT NOT NULL,
        message_type TEXT NOT NULL,
        text TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        error TEXT,
        source TEXT NOT NULL,
        provider_item_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_mission ON bus_messages(mission_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        files_json TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        source_thread_id TEXT,
        dedupe_key TEXT,
        quality_score INTEGER,
        quality_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_mission ON artifacts(mission_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS mission_runs (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        trigger_type TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_mission ON mission_runs(mission_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON mission_runs(task_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_turn ON mission_runs(thread_id, turn_id);
      CREATE TABLE IF NOT EXISTS mission_value_events (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        amount_cny REAL NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_value_events_mission ON mission_value_events(mission_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS mission_ui_state (
        mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
        layout_json TEXT NOT NULL DEFAULT '{}',
        viewport_json TEXT,
        panels_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attention_state (
        attention_id TEXT PRIMARY KEY,
        deferred_until TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attention_state_deferred ON attention_state(deferred_until);
      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        outcome TEXT NOT NULL,
        body TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'local',
        source_ref TEXT,
        workspace_path TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'inbox',
        labels_json TEXT NOT NULL DEFAULT '[]',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        value_contract_json TEXT NOT NULL DEFAULT '{}',
        mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requirements_queue ON requirements(status,priority,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_requirements_mission ON requirements(mission_id);
      CREATE TABLE IF NOT EXISTS trajectory_nodes (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        ref TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        file_path TEXT,
        content TEXT NOT NULL DEFAULT '',
        confidence TEXT NOT NULL DEFAULT 'reported',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(mission_id, ref)
      );
      CREATE INDEX IF NOT EXISTS idx_trajectory_nodes_mission ON trajectory_nodes(mission_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trajectory_nodes_task ON trajectory_nodes(mission_id, task_id, kind);
      CREATE TABLE IF NOT EXISTS trajectory_edges (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        from_ref TEXT NOT NULL,
        to_ref TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(mission_id, from_ref, to_ref, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_trajectory_edges_mission ON trajectory_edges(mission_id, from_ref, to_ref);
      CREATE TABLE IF NOT EXISTS file_identities (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        last_seen_commit TEXT,
        path_history_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_path, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_file_identities_workspace ON file_identities(workspace_path, updated_at DESC);
      CREATE TABLE IF NOT EXISTS trajectory_index_state (
        mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
        source_signature TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
    `);
    this.#ensureColumn("tasks", "commit_hash", "TEXT");
    this.#ensureColumn("missions", "integration_path", "TEXT");
    this.#ensureColumn("missions", "integration_branch", "TEXT");
    this.#ensureColumn("missions", "integration_commit", "TEXT");
    this.#ensureColumn("missions", "value_contract_json", "TEXT");
    this.#ensureColumn("missions", "execution_mode", "TEXT NOT NULL DEFAULT 'code'");
    this.#ensureColumn("missions", "execution_cwd", "TEXT");
    this.#ensureColumn("mission_events", "dedupe_key", "TEXT");
    this.#ensureColumn("artifacts", "dedupe_key", "TEXT");
    this.#ensureColumn("artifacts", "quality_score", "INTEGER");
    this.#ensureColumn("artifacts", "quality_json", "TEXT");
    this.#ensureColumn("bus_messages", "error", "TEXT");
    this.#ensureColumn("tasks", "value_json", "TEXT");
    this.#ensureColumn("requirements", "value_contract_json", "TEXT");
    this.#ensureColumn("requirements", "execution_mode", "TEXT NOT NULL DEFAULT 'code'");
    this.#exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON mission_events(mission_id,dedupe_key) WHERE dedupe_key IS NOT NULL;");
    this.#exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_dedupe ON artifacts(mission_id,dedupe_key) WHERE dedupe_key IS NOT NULL;");
  }

  createMission(input) {
    if (input.executionMode && !["code", "research"].includes(input.executionMode)) throw new Error("Invalid execution mode");
    const now = new Date().toISOString();
    const mission = {
      id: randomUUID(), title: input.title, outcome: input.outcome,
      sourcePrompt: input.sourcePrompt || input.outcome, cwd: input.cwd,
      provider: input.provider || "codex", model: input.model || null,
      valueContract: normalizeValueContract(input.valueContract),
      status: "planning", maxWorkers: Math.max(1, Math.min(8, input.maxWorkers || 4)),
      createdAt: now, updatedAt: now,
    };
    this.#exec(`INSERT INTO missions
      (id,title,outcome,source_prompt,cwd,provider,model,status,max_workers,value_contract_json,created_at,updated_at)
      VALUES (${quote(mission.id)},${quote(mission.title)},${quote(mission.outcome)},${quote(mission.sourcePrompt)},${quote(mission.cwd)},${quote(mission.provider)},${quote(mission.model)},${quote(mission.status)},${mission.maxWorkers},${json(mission.valueContract)},${quote(now)},${quote(now)});`);
    this.updateMission(mission.id, { executionMode: input.executionMode || "code" });
    this.appendEvent(mission.id, "mission.created", { title: mission.title, provider: mission.provider, executionMode: input.executionMode || "code", valueScenario: mission.valueContract.scenario, tokenBudget: mission.valueContract.tokenBudget });
    return this.getMission(mission.id);
  }

  rebindUnstartedWorkspace(id, cwd, executionMode = "code") {
    this.#exec(`BEGIN IMMEDIATE;
      UPDATE missions SET cwd=${quote(cwd)},execution_mode=${quote(executionMode)},execution_cwd=NULL,status='ready',error=NULL,updated_at=${quote(new Date().toISOString())} WHERE id=${quote(id)};
      UPDATE requirements SET execution_mode=${quote(executionMode)} WHERE mission_id=${quote(id)};
      UPDATE tasks SET status='queued',phase='ready',error=NULL WHERE mission_id=${quote(id)};
      COMMIT;`);
  }

  updateMission(id, patch) {
    if (patch.status !== undefined) assertMissionState(patch.status);
    const columns = {
      status: "status", mainThreadId: "main_thread_id", activeTurnId: "active_turn_id",
      spec: "spec_json", error: "error", model: "model", integrationPath: "integration_path",
      integrationBranch: "integration_branch", integrationCommit: "integration_commit",
      valueContract: "value_contract_json",
      executionMode: "execution_mode", executionCwd: "execution_cwd",
    };
    const values = Object.entries(patch).filter(([key]) => columns[key]).map(([key, value]) => {
      return `${columns[key]}=${key === "spec" || key === "valueContract" ? json(key === "valueContract" ? normalizeValueContract(value) : value) : quote(value)}`;
    });
    if (!values.length) return this.getMission(id);
    values.push(`updated_at=${quote(new Date().toISOString())}`);
    this.#exec(`UPDATE missions SET ${values.join(",")} WHERE id=${quote(id)};`);
    return this.getMission(id);
  }

  updateValueContract(missionId, contract) {
    if (!this.getMissionRecord(missionId)) throw new Error("Mission not found");
    const valueContract = normalizeValueContract(contract);
    this.updateMission(missionId, { valueContract });
    this.appendEvent(missionId, "value.contract.updated", {
      scenario: valueContract.scenario, valueType: valueContract.valueType,
      expectedValueCny: valueContract.expectedValueCny, tokenBudget: valueContract.tokenBudget,
    });
    return this.getMission(missionId);
  }

  recordValue(missionId, input = {}) {
    if (!this.getMissionRecord(missionId)) throw new Error("Mission not found");
    const eventType = ["confirmed_value", "avoided_cost", "learning_asset", "manual_cost"].includes(input.eventType) ? input.eventType : "confirmed_value";
    const amountCny = numberInRange(input.amountCny, 0, -100000000, 100000000);
    const note = String(input.note || "").trim().slice(0, 1200);
    if (!note) throw new Error("Add a short evidence note before recording value");
    const event = { id: randomUUID(), missionId, eventType, amountCny, note, source: "user", createdAt: new Date().toISOString() };
    this.#exec(`INSERT INTO mission_value_events (id,mission_id,event_type,amount_cny,note,source,created_at)
      VALUES (${quote(event.id)},${quote(event.missionId)},${quote(event.eventType)},${quote(event.amountCny)},${quote(event.note)},${quote(event.source)},${quote(event.createdAt)});`);
    this.appendEvent(missionId, "value.evidence.recorded", { eventType, amountCny, note: compactText(note, 180) });
    return event;
  }

  valueLedger(missionId) {
    const mission = this.getMission(missionId, { eventLimit: 500, messageLimit: 500, artifactLimit: 500 });
    if (!mission) throw new Error("Mission not found");
    const contract = normalizeValueContract(mission.valueContract);
    const valueEvents = this.#all(`SELECT * FROM mission_value_events WHERE mission_id=${quote(missionId)} ORDER BY created_at DESC;`).map((row) => ({
      id: row.id, eventType: row.event_type, amountCny: Number(row.amount_cny || 0), note: row.note, source: row.source, createdAt: row.created_at,
    }));
    const contextTokens = mission.events.filter((event) => event.type === "context.capsule.created").reduce((sum, event) => sum + Number(event.payload?.estimatedTokens || 0), 0);
    const plannerTokens = estimateTokens(`${mission.sourcePrompt}\n${mission.outcome}\n${JSON.stringify(mission.spec || {})}`);
    const outputTokens = mission.tasks.reduce((sum, task) => sum + estimateTokens(JSON.stringify(task.result || "")), 0);
    const coordinationTokens = mission.messages.reduce((sum, message) => sum + estimateTokens(message.text), 0);
    const estimatedTokens = plannerTokens + contextTokens + outputTokens + coordinationTokens;
    const observedTokens = mission.events.filter((event) => event.type === "provider.turn/completed").reduce((sum, event) => {
      const usage = event.payload?.turn?.usage || event.payload?.usage || {};
      return sum + Number(usage.total_tokens || usage.totalTokens || (Number(usage.prompt_tokens || usage.promptTokens || 0) + Number(usage.completion_tokens || usage.completionTokens || 0)) || 0);
    }, 0);
    const billedTokens = observedTokens > 0 ? observedTokens : estimatedTokens;
    const estimatedModelCostCny = Number((billedTokens / 1000 * contract.tokenCostPer1kCny).toFixed(4));
    const plannedValueCny = contract.expectedValueCny || Number((contract.baselineHours * contract.humanHourlyRateCny).toFixed(2));
    const confirmedValueCny = Number(valueEvents.filter((event) => event.eventType !== "manual_cost").reduce((sum, event) => sum + event.amountCny, 0).toFixed(2));
    const manualCostCny = Number(Math.abs(valueEvents.filter((event) => event.eventType === "manual_cost").reduce((sum, event) => sum + event.amountCny, 0)).toFixed(2));
    const totalCostCny = Number((estimatedModelCostCny + manualCostCny).toFixed(4));
    const realizedRoi = totalCostCny > 0 && confirmedValueCny > 0 ? Number(((confirmedValueCny - totalCostCny) / totalCostCny).toFixed(2)) : null;
    const projectedRoi = totalCostCny > 0 && plannedValueCny > 0 ? Number(((plannedValueCny - totalCostCny) / totalCostCny).toFixed(2)) : null;
    const verifiedArtifacts = mission.artifacts.filter((artifact) => artifact.verificationStatus === "user_verified").length;
    return {
      missionId, contract, valueEvents,
      costs: { estimatedTokens, observedTokens, billedTokens, tokenSource: observedTokens > 0 ? "provider_reported" : "local_estimate", plannerTokens, contextTokens, outputTokens, coordinationTokens, estimatedModelCostCny, manualCostCny, totalCostCny, tokenBudgetRemaining: Math.max(0, contract.tokenBudget - billedTokens) },
      value: { plannedValueCny, confirmedValueCny, projectedRoi, realizedRoi, verifiedArtifacts, completedTasks: mission.tasks.filter((task) => task.status === "completed").length, totalTasks: mission.tasks.length },
      disclaimer: observedTokens > 0 ? "Token usage is reported by the active provider where available; cost still uses your locally configured rate. Confirmed value is recorded only from your evidence entries." : "Token and model cost are local estimates using your configured rate. Confirmed value is recorded only from your evidence entries.",
    };
  }

  savePlan(missionId, spec) {
    const now = new Date().toISOString();
    const statements = [
      `UPDATE missions SET title=${quote(spec.title)},outcome=${quote(spec.outcome)},spec_json=${json(spec)},status='ready',active_turn_id=NULL,error=NULL,updated_at=${quote(now)} WHERE id=${quote(missionId)};`,
      `DELETE FROM tasks WHERE mission_id=${quote(missionId)};`,
    ];
    for (const task of spec.tasks) {
      statements.push(`INSERT INTO tasks
        (id,mission_id,task_key,title,description,agent_role,status,phase,dependencies_json,acceptance_json,value_json,evidence_json,created_at,updated_at)
        VALUES (${quote(randomUUID())},${quote(missionId)},${quote(task.key)},${quote(task.title)},${quote(task.description)},${quote(task.agentRole)},'queued','ready',${json(task.dependencies)},${json(task.acceptanceCriteria)},${json(task.value)},'[]',${quote(now)},${quote(now)});`);
    }
    this.#transaction(statements);
    this.appendEvent(missionId, "mission.plan.ready", { taskCount: spec.tasks.length });
    return this.getMission(missionId);
  }

  updatePlan(missionId, spec) {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    if (mission.status !== "ready") throw new Error("The task graph can only be edited before worker dispatch");
    if (mission.tasks.some((task) => task.agentThreadId || task.worktreePath || task.status !== "queued")) {
      throw new Error("The task graph is already executing and cannot be rewritten safely");
    }
    const now = new Date().toISOString();
    const nextKeys = new Set(spec.tasks.map((task) => task.key));
    const currentByKey = new Map(mission.tasks.map((task) => [task.key, task]));
    const statements = [
      `UPDATE missions SET title=${quote(spec.title)},outcome=${quote(spec.outcome)},spec_json=${json(spec)},error=NULL,updated_at=${quote(now)} WHERE id=${quote(missionId)};`,
    ];
    for (const current of mission.tasks) {
      if (!nextKeys.has(current.key)) statements.push(`DELETE FROM tasks WHERE id=${quote(current.id)};`);
    }
    for (const task of spec.tasks) {
      const current = currentByKey.get(task.key);
      if (current) {
        statements.push(`UPDATE tasks SET title=${quote(task.title)},description=${quote(task.description)},agent_role=${quote(task.agentRole)},dependencies_json=${json(task.dependencies)},acceptance_json=${json(task.acceptanceCriteria)},value_json=${json(task.value)},updated_at=${quote(now)} WHERE id=${quote(current.id)};`);
      } else {
        statements.push(`INSERT INTO tasks
          (id,mission_id,task_key,title,description,agent_role,status,phase,dependencies_json,acceptance_json,value_json,evidence_json,created_at,updated_at)
          VALUES (${quote(randomUUID())},${quote(missionId)},${quote(task.key)},${quote(task.title)},${quote(task.description)},${quote(task.agentRole)},'queued','ready',${json(task.dependencies)},${json(task.acceptanceCriteria)},${json(task.value)},'[]',${quote(now)},${quote(now)});`);
      }
    }
    this.#transaction(statements);
    this.appendEvent(missionId, "mission.plan.updated", {
      taskCount: spec.tasks.length,
      added: spec.tasks.filter((task) => !currentByKey.has(task.key)).map((task) => task.key),
      removed: mission.tasks.filter((task) => !nextKeys.has(task.key)).map((task) => task.key),
    });
    return this.getMission(missionId);
  }

  saveUiState(missionId, patch = {}) {
    if (!this.getMissionRecord(missionId)) throw new Error("Mission not found");
    const current = this.#all(`SELECT * FROM mission_ui_state WHERE mission_id=${quote(missionId)} LIMIT 1;`)[0];
    const sanitizePosition = (position) => ({
      x: Number.isFinite(Number(position?.x)) ? Number(position.x) : 0,
      y: Number.isFinite(Number(position?.y)) ? Number(position.y) : 0,
    });
    const currentLayout = parseJson(current?.layout_json, {});
    const positions = { ...(currentLayout.positions || {}) };
    for (const [key, value] of Object.entries(patch.layout?.positions || {})) positions[key] = sanitizePosition(value);
    for (const key of patch.layout?.removedKeys || []) delete positions[key];
    const layout = { ...currentLayout, ...(patch.layout || {}), positions };
    delete layout.removedKeys;
    const currentPanels = parseJson(current?.panels_json, {});
    const panels = { ...currentPanels, ...(patch.panels || {}) };
    const viewport = patch.viewport === undefined ? parseJson(current?.viewport_json, null) : {
      x: Number(patch.viewport?.x) || 0,
      y: Number(patch.viewport?.y) || 0,
      zoom: Math.max(0.2, Math.min(2, Number(patch.viewport?.zoom) || 1)),
    };
    const now = new Date().toISOString();
    this.#exec(`INSERT INTO mission_ui_state (mission_id,layout_json,viewport_json,panels_json,updated_at)
      VALUES (${quote(missionId)},${json(layout)},${json(viewport)},${json(panels)},${quote(now)})
      ON CONFLICT(mission_id) DO UPDATE SET layout_json=excluded.layout_json,viewport_json=excluded.viewport_json,panels_json=excluded.panels_json,updated_at=excluded.updated_at;`);
    return this.getMission(missionId);
  }

  startRun(input) {
    const now = new Date().toISOString();
    const existing = input.threadId && input.turnId ? this.#all(`SELECT * FROM mission_runs WHERE thread_id=${quote(input.threadId)} AND turn_id=${quote(input.turnId)} LIMIT 1;`)[0] : null;
    if (existing) return this.#runRecord(existing);
    const attemptRow = this.#all(`SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id=${quote(input.missionId)} AND ${input.taskId ? `task_id=${quote(input.taskId)}` : "task_id IS NULL"};`)[0];
    const run = {
      id: randomUUID(), missionId: input.missionId, taskId: input.taskId || null,
      agentId: input.agentId, threadId: input.threadId || null, turnId: input.turnId || null,
      status: input.status || "running", phase: input.phase || "working",
      attempt: Number(attemptRow?.count || 0) + 1, triggerType: input.triggerType || "provider",
      error: null, startedAt: now, endedAt: null, createdAt: now, updatedAt: now,
    };
    this.#exec(`INSERT INTO mission_runs
      (id,mission_id,task_id,agent_id,thread_id,turn_id,status,phase,attempt,trigger_type,error,started_at,ended_at,created_at,updated_at)
      VALUES (${quote(run.id)},${quote(run.missionId)},${quote(run.taskId)},${quote(run.agentId)},${quote(run.threadId)},${quote(run.turnId)},${quote(run.status)},${quote(run.phase)},${run.attempt},${quote(run.triggerType)},NULL,${quote(now)},NULL,${quote(now)},${quote(now)});`);
    return run;
  }

  completeRun(threadId, turnId, patch = {}) {
    if (!threadId || !turnId) return null;
    const row = this.#all(`SELECT * FROM mission_runs WHERE thread_id=${quote(threadId)} AND turn_id=${quote(turnId)} LIMIT 1;`)[0];
    if (!row) return null;
    const now = new Date().toISOString();
    this.#exec(`UPDATE mission_runs SET status=${quote(patch.status || "completed")},phase=${quote(patch.phase || "finished")},error=${quote(patch.error)},ended_at=${quote(now)},updated_at=${quote(now)} WHERE id=${quote(row.id)};`);
    return this.#runRecord(this.#all(`SELECT * FROM mission_runs WHERE id=${quote(row.id)} LIMIT 1;`)[0]);
  }

  appendTasks(missionId, tasks) {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    if (!Array.isArray(tasks) || !tasks.length) return mission;
    const existingKeys = new Set(mission.tasks.map((task) => task.key));
    for (const task of tasks) {
      if (existingKeys.has(task.key)) throw new Error(`Task key ${task.key} already exists`);
      existingKeys.add(task.key);
    }
    const now = new Date().toISOString();
    const mergedSpec = mission.spec ? { ...mission.spec, tasks: [...(mission.spec.tasks || []), ...tasks] } : null;
    const statements = [
      `UPDATE missions SET status='running',spec_json=${json(mergedSpec)},active_turn_id=NULL,error=NULL,updated_at=${quote(now)} WHERE id=${quote(missionId)};`,
    ];
    for (const task of tasks) {
      statements.push(`INSERT INTO tasks
        (id,mission_id,task_key,title,description,agent_role,status,phase,dependencies_json,acceptance_json,value_json,evidence_json,created_at,updated_at)
        VALUES (${quote(randomUUID())},${quote(missionId)},${quote(task.key)},${quote(task.title)},${quote(task.description)},${quote(task.agentRole)},'queued','ready',${json(task.dependencies)},${json(task.acceptanceCriteria)},${json(task.value)},'[]',${quote(now)},${quote(now)});`);
    }
    this.#transaction(statements);
    this.appendEvent(missionId, "mission.tasks.appended", { taskKeys: tasks.map((task) => task.key), taskCount: tasks.length });
    return this.getMission(missionId);
  }

  updateTask(id, patch) {
    if (patch.status !== undefined) assertTaskState(patch.status);
    const columns = {
      status: "status", phase: "phase", result: "result_json", evidence: "evidence_json",
      agentThreadId: "agent_thread_id", activeTurnId: "active_turn_id", worktreePath: "worktree_path",
      branch: "branch", commitHash: "commit_hash", error: "error",
    };
    const jsonKeys = new Set(["result", "evidence"]);
    const values = Object.entries(patch).filter(([key]) => columns[key]).map(([key, value]) => {
      return `${columns[key]}=${jsonKeys.has(key) ? json(value) : quote(value)}`;
    });
    if (!values.length) return this.getTask(id);
    values.push(`updated_at=${quote(new Date().toISOString())}`);
    this.#exec(`UPDATE tasks SET ${values.join(",")} WHERE id=${quote(id)};`);
    return this.getTask(id);
  }

  claimTask(id) {
    const now = new Date().toISOString();
    if (this.database) {
      return this.database.prepare("UPDATE tasks SET status='claiming',phase='claiming',updated_at=? WHERE id=? AND status='queued'").run(now, id).changes === 1;
    }
    const result = this.#all(`UPDATE tasks SET status='claiming',phase='claiming',updated_at=${quote(now)} WHERE id=${quote(id)} AND status='queued'; SELECT changes() AS claimed;`);
    return result[0]?.claimed === 1;
  }

  appendEvent(missionId, eventType, payload = {}, meta = {}) {
    if (meta.dedupeKey && this.hasEvent(missionId, meta.dedupeKey)) return false;
    const now = new Date().toISOString();
    this.#exec(`INSERT OR IGNORE INTO mission_events (mission_id,task_id,thread_id,event_type,dedupe_key,payload_json,created_at)
      VALUES (${quote(missionId)},${quote(meta.taskId)},${quote(meta.threadId)},${quote(eventType)},${quote(meta.dedupeKey)},${json(payload)},${quote(now)});`);
    return true;
  }

  hasEvent(missionId, dedupeKey) {
    if (!dedupeKey) return false;
    return Boolean(this.#all(`SELECT 1 AS present FROM mission_events WHERE mission_id=${quote(missionId)} AND dedupe_key=${quote(dedupeKey)} LIMIT 1;`)[0]);
  }

  addMessage(input) {
    if (input.providerItemId) {
      const existing = this.#all(`SELECT * FROM bus_messages WHERE mission_id=${quote(input.missionId)} AND provider_item_id=${quote(input.providerItemId)} LIMIT 1;`)[0];
      if (existing) return this.#message(existing);
    }
    const message = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.#exec(`INSERT INTO bus_messages
      (id,mission_id,from_agent,to_agent,topic,message_type,text,delivery_status,error,source,provider_item_id,created_at)
      VALUES (${quote(message.id)},${quote(message.missionId)},${quote(message.fromAgent)},${quote(message.toAgent)},${quote(message.topic)},${quote(message.messageType || "event")},${quote(message.text)},${quote(message.deliveryStatus || "delivered")},${quote(message.error)},${quote(message.source || "agent-deck")},${quote(message.providerItemId)},${quote(message.createdAt)});`);
    return message;
  }

  updateMessage(id, patch = {}) {
    const row = this.#all(`SELECT * FROM bus_messages WHERE id=${quote(id)} LIMIT 1;`)[0];
    if (!row) return null;
    const values = [];
    if (patch.deliveryStatus !== undefined) values.push(`delivery_status=${quote(patch.deliveryStatus)}`);
    if (patch.error !== undefined) values.push(`error=${quote(patch.error)}`);
    if (!values.length) return this.#message(row);
    this.#exec(`UPDATE bus_messages SET ${values.join(",")} WHERE id=${quote(id)};`);
    return this.#message(this.#all(`SELECT * FROM bus_messages WHERE id=${quote(id)} LIMIT 1;`)[0]);
  }

  addArtifact(input) {
    if (input.dedupeKey) {
      const existing = this.#all(`SELECT * FROM artifacts WHERE mission_id=${quote(input.missionId)} AND dedupe_key=${quote(input.dedupeKey)} LIMIT 1;`)[0];
      if (existing) return this.#artifact(existing);
    }
    const artifact = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.#exec(`INSERT INTO artifacts
      (id,mission_id,task_id,title,summary,files_json,verification_status,source_thread_id,dedupe_key,quality_score,quality_json,created_at)
      VALUES (${quote(artifact.id)},${quote(artifact.missionId)},${quote(artifact.taskId)},${quote(artifact.title)},${quote(artifact.summary)},${json(artifact.files || [])},${quote(artifact.verificationStatus || "unverified")},${quote(artifact.sourceThreadId)},${quote(artifact.dedupeKey)},${quote(artifact.qualityScore)},${json(artifact.reportQuality || null)},${quote(artifact.createdAt)});`);
    return artifact;
  }

  updateLatestTaskArtifact(missionId, taskId, patch = {}) {
    const row = this.#all(`SELECT * FROM artifacts WHERE mission_id=${quote(missionId)} AND task_id=${quote(taskId)} ORDER BY created_at DESC LIMIT 1;`)[0];
    if (!row) return null;
    const values = [];
    if (patch.summary !== undefined) values.push(`summary=${quote(patch.summary)}`);
    if (patch.files !== undefined) values.push(`files_json=${json(patch.files)}`);
    if (patch.verificationStatus !== undefined) values.push(`verification_status=${quote(patch.verificationStatus)}`);
    if (!values.length) return this.#artifact(row);
    this.#exec(`UPDATE artifacts SET ${values.join(",")} WHERE id=${quote(row.id)};`);
    return this.getArtifact(row.id);
  }

  verifyTaskArtifacts(missionId, taskId) {
    this.#exec(`UPDATE artifacts SET verification_status='user_verified' WHERE mission_id=${quote(missionId)} AND task_id=${quote(taskId)};`);
  }

  getTask(id) {
    const row = this.#all(`SELECT * FROM tasks WHERE id=${quote(id)} LIMIT 1;`)[0];
    return row ? this.#task(row) : null;
  }

  findTaskByThread(threadId) {
    const row = this.#all(`SELECT * FROM tasks WHERE agent_thread_id=${quote(threadId)} LIMIT 1;`)[0];
    return row ? this.#task(row) : null;
  }

  findMissionByThread(threadId) {
    const mission = this.findMissionRecordByThread(threadId);
    return mission ? this.getMission(mission.id) : null;
  }

  findMissionRecordByThread(threadId) {
    const row = this.#all(`SELECT DISTINCT m.* FROM missions m LEFT JOIN tasks t ON t.mission_id=m.id
      WHERE m.main_thread_id=${quote(threadId)} OR t.agent_thread_id=${quote(threadId)} LIMIT 1;`)[0];
    return row ? this.#mission(row) : null;
  }

  getMissionRecord(id) {
    const row = this.#all(`SELECT * FROM missions WHERE id=${quote(id)} LIMIT 1;`)[0];
    return row ? this.#mission(row) : null;
  }

  hasActiveTasks(missionId) {
    const row = this.#all(`SELECT EXISTS(SELECT 1 FROM tasks WHERE mission_id=${quote(missionId)} AND status IN ('claiming','running','waiting_approval')) AS active;`)[0];
    return Boolean(row?.active);
  }

  listMissions(options = {}) {
    if (options.detailed) {
      return this.#all("SELECT * FROM missions ORDER BY created_at DESC;").map((row) => this.#snapshot(row, options));
    }
    return this.#all(`SELECT m.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.mission_id=m.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.mission_id=m.id AND t.status='completed') AS completed_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.mission_id=m.id AND t.status IN ('claiming','running','waiting_approval')) AS active_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.mission_id=m.id AND t.status IN ('blocked','waiting_approval','review')) AS attention_count,
      (SELECT COUNT(*) FROM artifacts a WHERE a.mission_id=m.id) AS artifact_count,
      (SELECT COUNT(*) FROM bus_messages b WHERE b.mission_id=m.id) AS message_count
      FROM missions m ORDER BY m.created_at DESC;`).map((row) => ({
        ...this.#mission(row),
        counts: {
          tasks: Number(row.task_count || 0), completed: Number(row.completed_count || 0),
          active: Number(row.active_count || 0), attention: Number(row.attention_count || 0),
          artifacts: Number(row.artifact_count || 0), messages: Number(row.message_count || 0),
        },
      }));
  }

  createRequirement(input) {
    if (input.executionMode && !["code", "research"].includes(input.executionMode)) throw new Error("Invalid execution mode");
    const title = String(input.title || "").trim();
    const outcome = String(input.outcome || "").trim();
    const body = String(input.body || "").trim() || `需求：${title}`;
    const workspacePath = String(input.workspacePath || "").trim();
    if (!title || !outcome || !workspacePath) throw new Error("Title, outcome, and workspace are required");
    const priority = ["urgent", "high", "medium", "low"].includes(input.priority) ? input.priority : "medium";
    const status = ["inbox", "ready_to_plan"].includes(input.status) ? input.status : "inbox";
    const now = new Date().toISOString();
    const requirement = { id: randomUUID(), title, outcome, body, sourceType: input.sourceType || "local", sourceRef: input.sourceRef || null, workspacePath, priority, status, labels: Array.isArray(input.labels) ? input.labels.filter(Boolean).slice(0, 12) : [], acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.filter(Boolean).slice(0, 20) : [], valueContract: normalizeValueContract(input.valueContract), createdAt: now, updatedAt: now };
    this.#exec(`INSERT INTO requirements (id,title,outcome,body,source_type,source_ref,workspace_path,priority,status,labels_json,acceptance_json,value_contract_json,created_at,updated_at)
      VALUES (${quote(requirement.id)},${quote(requirement.title)},${quote(requirement.outcome)},${quote(requirement.body)},${quote(requirement.sourceType)},${quote(requirement.sourceRef)},${quote(requirement.workspacePath)},${quote(requirement.priority)},${quote(requirement.status)},${json(requirement.labels)},${json(requirement.acceptanceCriteria)},${json(requirement.valueContract)},${quote(now)},${quote(now)});`);
    this.#exec(`UPDATE requirements SET execution_mode=${quote(input.executionMode || "code")} WHERE id=${quote(requirement.id)};`);
    return this.getRequirement(requirement.id);
  }

  listRequirements(options = {}) {
    const workspaceWhere = options.workspacePath ? `WHERE r.workspace_path=${quote(options.workspacePath)}` : "";
    return this.#all(`SELECT r.*,m.status AS mission_status,m.title AS mission_title FROM requirements r LEFT JOIN missions m ON m.id=r.mission_id ${workspaceWhere} ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,r.updated_at DESC;`).map((row) => this.#requirement(row));
  }

  getRequirement(id) {
    const row = this.#all(`SELECT r.*,m.status AS mission_status,m.title AS mission_title FROM requirements r LEFT JOIN missions m ON m.id=r.mission_id WHERE r.id=${quote(id)} LIMIT 1;`)[0];
    return row ? this.#requirement(row) : null;
  }

  updateRequirement(id, patch) {
    const current = this.getRequirement(id);
    if (!current) throw new Error("Requirement was not found");
    const allowedStatuses = new Set(["inbox", "clarifying", "ready_to_plan", "planning", "awaiting_approval", "running", "review", "done", "blocked", "archived"]);
    const allowedPriorities = new Set(["urgent", "high", "medium", "low"]);
    const next = {
      title: patch.title === undefined ? current.title : String(patch.title || "").trim(), outcome: patch.outcome === undefined ? current.outcome : String(patch.outcome || "").trim(),
      body: patch.body === undefined ? current.body : String(patch.body || "").trim(), sourceType: patch.sourceType === undefined ? current.sourceType : patch.sourceType,
      sourceRef: patch.sourceRef === undefined ? current.sourceRef : patch.sourceRef, workspacePath: patch.workspacePath === undefined ? current.workspacePath : patch.workspacePath,
      priority: patch.priority === undefined ? current.priority : patch.priority, status: patch.status === undefined ? current.status : patch.status,
      labels: patch.labels === undefined ? current.labels : patch.labels, acceptanceCriteria: patch.acceptanceCriteria === undefined ? current.acceptanceCriteria : patch.acceptanceCriteria,
      valueContract: patch.valueContract === undefined ? current.valueContract : normalizeValueContract(patch.valueContract),
      missionId: patch.missionId === undefined ? current.missionId : patch.missionId,
    };
    if (!next.title || !next.outcome || !next.body || !next.workspacePath) throw new Error("Requirement fields cannot be empty");
    if (!allowedStatuses.has(next.status)) throw new Error("Unknown requirement status");
    if (!allowedPriorities.has(next.priority)) throw new Error("Unknown requirement priority");
    const now = new Date().toISOString();
    this.#exec(`UPDATE requirements SET title=${quote(next.title)},outcome=${quote(next.outcome)},body=${quote(next.body)},source_type=${quote(next.sourceType)},source_ref=${quote(next.sourceRef)},workspace_path=${quote(next.workspacePath)},priority=${quote(next.priority)},status=${quote(next.status)},labels_json=${json(next.labels)},acceptance_json=${json(next.acceptanceCriteria)},value_contract_json=${json(next.valueContract)},mission_id=${quote(next.missionId)},updated_at=${quote(now)} WHERE id=${quote(id)};`);
    return this.getRequirement(id);
  }

  claimRequirement(id) {
    const current = this.getRequirement(id);
    if (!current) throw new Error("Requirement was not found");
    if (!["inbox", "clarifying", "ready_to_plan"].includes(current.status)) throw new Error("Requirement is already linked to an active or completed Mission");
    return this.updateRequirement(id, { status: "planning" });
  }

  claimNextRequirement(workspacePath) {
    const requirement = this.#all(`SELECT id FROM requirements WHERE status='ready_to_plan'${workspacePath ? ` AND workspace_path=${quote(workspacePath)}` : ""} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,created_at LIMIT 1;`)[0];
    return requirement ? this.claimRequirement(requirement.id) : null;
  }

  syncRequirementForMission(missionId, missionStatus) {
    const requirement = this.#all(`SELECT id,status FROM requirements WHERE mission_id=${quote(missionId)} LIMIT 1;`)[0];
    if (!requirement) return null;
    const status = ({ planning: "planning", ready: "awaiting_approval", running: "running", review: "review", ready_to_integrate: "review", completed: "done", blocked: "blocked", failed: "blocked", integration_conflict: "blocked", canceled: "blocked" })[missionStatus];
    return status && status !== requirement.status ? this.updateRequirement(requirement.id, { status }) : this.getRequirement(requirement.id);
  }

  listAttentionItems(options = {}) {
    const now = new Date().toISOString();
    const includeDeferred = Boolean(options.includeDeferred);
    const missionRows = this.#all(`SELECT id,title,outcome,cwd,status,error,value_contract_json,updated_at
      FROM missions
      WHERE status IN ('ready','ready_to_integrate','integration_conflict','failed')
      ORDER BY updated_at DESC;`);
    const taskRows = this.#all(`SELECT t.id,t.mission_id,t.task_key,t.title,t.agent_role,t.status,t.phase,
      t.dependencies_json,t.result_json,t.value_json,t.error,t.updated_at,m.title AS mission_title,m.cwd AS mission_cwd
      FROM tasks t JOIN missions m ON m.id=t.mission_id
      WHERE t.status IN ('review','blocked','waiting_approval')
      ORDER BY t.updated_at DESC;`);
    const dependencyRows = this.#all(`SELECT mission_id,task_key,dependencies_json
      FROM tasks WHERE mission_id IN (SELECT id FROM missions WHERE status NOT IN ('completed','cancelled'));`);
    const downstreamByTask = new Map();
    const children = new Map();
    for (const row of dependencyRows) {
      for (const dependency of parseJson(row.dependencies_json, [])) {
        const parent = `${row.mission_id}:${dependency}`;
        const current = children.get(parent) || [];
        current.push(row.task_key);
        children.set(parent, current);
      }
    }
    for (const row of dependencyRows) {
      const seen = new Set();
      const visit = (key) => {
        for (const child of children.get(`${row.mission_id}:${key}`) || []) {
          if (seen.has(child)) continue;
          seen.add(child);
          visit(child);
        }
      };
      visit(row.task_key);
      downstreamByTask.set(`${row.mission_id}:${row.task_key}`, seen.size);
    }
    const missionType = {
      ready: ["plan_review", "Review mission plan", "The Main Agent plan is ready, but no Worker will start until you approve it.", "Review plan"],
      ready_to_integrate: ["integration_ready", "Review integration", "Every task is verified. Review the mission result before creating the integration branch.", "Review integration"],
      integration_conflict: ["integration_conflict", "Resolve integration conflict", "The verified task branches could not be integrated automatically.", "Inspect conflict"],
      failed: ["mission_failed", "Mission needs recovery", "The mission runtime failed and needs your decision before it can continue.", "Inspect failure"],
    };
    const missionItems = missionRows.map((row) => {
      const [type, title, fallback, primaryLabel] = missionType[row.status];
      const basePriority = { ready: 58, ready_to_integrate: 68, integration_conflict: 95, failed: 88 }[row.status] || 50;
      const contract = normalizeValueContract(parseJson(row.value_contract_json, {}));
      return {
        id: `${row.id}:${type}:mission`, type, severity: ["integration_conflict", "failed"].includes(row.status) ? "critical" : "medium",
        missionId: row.id, missionTitle: row.title, missionStatus: row.status, taskId: null, taskKey: null,
        taskTitle: null, agentRole: "Main Agent", status: row.status, phase: row.status,
        title, reason: row.error || fallback, suggestedAction: primaryLabel, primaryLabel,
        workspace: row.cwd, panel: "result", tab: row.status === "ready" ? "spec" : "graph", updatedAt: row.updated_at,
        priority: basePriority, prioritySource: "derived", impact: 0, confidence: 100,
        valueScore: 0, estimatedTokenBudget: contract.tokenBudget,
        whyNow: row.status === "ready" ? ["执行尚未开始", "需要确认任务计划"] : row.status === "integration_conflict" ? ["自动集成失败", "需要选择冲突处理方式"] : ["Mission 状态需要你的决定"],
      };
    });
    const taskType = {
      review: ["worker_review", "Review worker result", "Inspect the structured result, evidence, changed files, and published artifacts.", "Review result"],
      blocked: ["worker_blocked", "Unblock worker", "The Worker stopped and cannot continue without recovery or a new instruction.", "Resolve blocker"],
      waiting_approval: ["worker_approval", "Approve worker action", "Codex is waiting for a command or file-change approval.", "Review request"],
    };
    const taskItems = taskRows.map((row) => {
      const result = parseJson(row.result_json, {});
      const value = parseJson(row.value_json, { score: 3, estimatedTokenBudget: 6000 });
      const blockers = Array.isArray(result?.blockers) ? result.blockers.filter(Boolean) : [];
      const [type, title, fallback, primaryLabel] = taskType[row.status];
      const reason = row.error || blockers.join("; ") || (row.status === "review" && result?.summary) || fallback;
      const downstream = downstreamByTask.get(`${row.mission_id}:${row.task_key}`) || 0;
      const basePriority = { blocked: 92, waiting_approval: 80, review: 62 }[row.status] || 50;
      const impact = Math.min(16, downstream * 5);
      const whyNow = row.status === "blocked"
        ? ["Worker 已停止，无法自行推进", ...(downstream ? [`阻塞 ${downstream} 个下游任务`] : []), "需要恢复决策或新指令"]
        : row.status === "waiting_approval"
          ? ["Provider 正在等待你的许可", ...(downstream ? [`完成后可释放 ${downstream} 个下游任务`] : []), "批准或拒绝后才能继续"]
          : ["结果和证据已就绪", ...(downstream ? [`确认后可释放 ${downstream} 个下游任务`] : []), "等待你的验收决定"];
      return {
        id: `${row.mission_id}:${type}:${row.id}`, type, severity: row.status === "blocked" ? "critical" : row.status === "waiting_approval" ? "high" : "medium",
        missionId: row.mission_id, missionTitle: row.mission_title, missionStatus: null,
        taskId: row.id, taskKey: row.task_key, taskTitle: row.title, agentRole: row.agent_role,
        status: row.status, phase: row.phase, title, reason, suggestedAction: primaryLabel, primaryLabel,
        workspace: row.mission_cwd, panel: row.status === "review" ? "result" : row.status === "waiting_approval" ? "conversation" : "evidence",
        tab: "graph", updatedAt: row.updated_at, priority: Math.min(100, basePriority + impact), prioritySource: "derived",
        impact: downstream, confidence: 100,
        valueScore: Math.max(0, Math.min(5, Number(value.score || 0))), estimatedTokenBudget: Math.max(500, Number(value.estimatedTokenBudget || 6000)), whyNow,
      };
    });
    const stateRows = this.#all("SELECT attention_id,deferred_until FROM attention_state WHERE deferred_until IS NOT NULL;");
    const stateById = new Map(stateRows.map((row) => [row.attention_id, row.deferred_until]));
    return [...missionItems, ...taskItems]
      .map((item) => ({ ...item, deferredUntil: stateById.get(item.id) || null }))
      .filter((item) => includeDeferred || !item.deferredUntil || item.deferredUntil <= now)
      .sort((left, right) => right.priority - left.priority || String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  deferAttention(attentionId, minutes) {
    const allowedMinutes = new Set([15, 60, 240, 1440]);
    const normalizedMinutes = Number(minutes);
    if (!allowedMinutes.has(normalizedMinutes)) throw new Error("Choose a valid attention deferral interval");
    const item = this.listAttentionItems({ includeDeferred: true }).find((entry) => entry.id === attentionId);
    if (!item) throw new Error("This attention item is no longer active");
    const now = new Date();
    const deferredUntil = new Date(now.getTime() + normalizedMinutes * 60_000).toISOString();
    this.#exec(`INSERT INTO attention_state (attention_id,deferred_until,updated_at)
      VALUES (${quote(attentionId)},${quote(deferredUntil)},${quote(now.toISOString())})
      ON CONFLICT(attention_id) DO UPDATE SET deferred_until=excluded.deferred_until,updated_at=excluded.updated_at;`);
    return { attentionId, deferredUntil };
  }

  listAttentionBriefing() {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const items = this.listAttentionItems();
    const allActiveItems = this.listAttentionItems({ includeDeferred: true });
    const taskCounts = this.#all(`SELECT
      SUM(CASE WHEN status IN ('claiming','running','waiting_approval') THEN 1 ELSE 0 END) AS active_workers,
      SUM(CASE WHEN status='completed' AND updated_at>=${quote(windowStart)} THEN 1 ELSE 0 END) AS verified_last_day
      FROM tasks;`)[0] || {};
    const artifactCount = this.#all(`SELECT COUNT(*) AS count FROM artifacts WHERE created_at>=${quote(windowStart)};`)[0] || {};
    const recentMissions = this.#all(`SELECT m.id,m.title,m.status,m.updated_at,
      (SELECT COUNT(*) FROM tasks t WHERE t.mission_id=m.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.mission_id=m.id AND t.status='completed') AS completed_count
      FROM missions m WHERE m.updated_at>=${quote(windowStart)} ORDER BY m.updated_at DESC LIMIT 5;`).map((row) => ({
      id: row.id, title: row.title, status: row.status, updatedAt: row.updated_at,
      taskCount: Number(row.task_count || 0), completedCount: Number(row.completed_count || 0),
    }));
    return {
      generatedAt: new Date().toISOString(), windowStart,
      source: "local-ledger",
      totals: {
        openDecisions: items.length,
        critical: items.filter((item) => item.severity === "critical").length,
        activeWorkers: Number(taskCounts.active_workers || 0),
        verifiedLastDay: Number(taskCounts.verified_last_day || 0),
        artifactsLastDay: Number(artifactCount.count || 0),
        deferred: allActiveItems.filter((item) => item.deferredUntil && item.deferredUntil > new Date().toISOString()).length,
      },
      topItems: items.slice(0, 3), recentMissions,
    };
  }

  listSessionRefs(cwd) {
    const where = cwd ? `WHERE m.cwd=${quote(cwd)}` : "";
    const missions = this.#all(`SELECT m.id,m.title,m.outcome,m.cwd,m.execution_cwd,m.model,m.status,m.main_thread_id,m.active_turn_id,m.created_at,m.updated_at
      FROM missions m ${where} ORDER BY m.created_at DESC;`);
    const tasks = this.#all(`SELECT t.id,t.mission_id,t.task_key,t.title,t.description,t.agent_role,t.status,t.phase,
      t.agent_thread_id,t.active_turn_id,t.worktree_path,t.branch,t.error,t.created_at,t.updated_at
      FROM tasks t JOIN missions m ON m.id=t.mission_id
      ${where ? `${where} AND` : "WHERE"} t.agent_thread_id IS NOT NULL
      ORDER BY m.created_at DESC,t.created_at,t.task_key;`);
    const missionById = new Map(missions.map((mission) => [mission.id, mission]));
    const refs = [];
    for (const mission of missions) {
      if (mission.main_thread_id) {
        refs.push({
          threadId: mission.main_thread_id, missionId: mission.id, missionTitle: mission.title,
          role: "planner", title: "Main Agent · Planner", agentRole: "Main Agent",
          goal: mission.outcome, cwd: mission.execution_cwd || mission.cwd, branch: null, model: mission.model,
          status: mission.status, phase: mission.status, activeTurnId: mission.active_turn_id,
          error: null, createdAt: mission.created_at, updatedAt: mission.updated_at,
        });
      }
    }
    for (const task of tasks) {
      const owner = missionById.get(task.mission_id);
      refs.push({
        threadId: task.agent_thread_id, missionId: task.mission_id,
        missionTitle: owner?.title || "Mission",
        taskId: task.id, taskKey: task.task_key, role: "worker", title: task.title,
        agentRole: task.agent_role, goal: task.description, cwd: task.worktree_path,
        branch: task.branch, model: owner?.model || null,
        status: task.status, phase: task.phase, activeTurnId: task.active_turn_id,
        error: task.error, createdAt: task.created_at, updatedAt: task.updated_at,
      });
    }
    return refs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  listWorktreePaths() {
    return this.#all("SELECT DISTINCT worktree_path FROM tasks WHERE worktree_path IS NOT NULL AND worktree_path<>'';")
      .map((row) => row.worktree_path)
      .filter(Boolean);
  }

  getMission(id, options = {}) {
    const row = this.#all(`SELECT * FROM missions WHERE id=${quote(id)} LIMIT 1;`)[0];
    return row ? this.#snapshot(row, options) : null;
  }

  getMissionStatus(id) {
    return this.#all(`SELECT status FROM missions WHERE id=${quote(id)} LIMIT 1;`)[0]?.status || null;
  }

  getArtifact(id) {
    const row = this.#all(`SELECT * FROM artifacts WHERE id=${quote(id)} LIMIT 1;`)[0];
    return row ? this.#artifact(row) : null;
  }

  listEvents(missionId, options = {}) {
    const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
    const before = Number(options.beforeSeq || 0);
    const where = before > 0 ? ` AND seq<${before}` : "";
    const rows = this.#all(`SELECT * FROM mission_events WHERE mission_id=${quote(missionId)}${where} ORDER BY seq DESC LIMIT ${limit + 1};`);
    return {
      items: rows.slice(0, limit).map((item) => this.#event(item)),
      nextBeforeSeq: rows.length > limit ? rows[limit - 1]?.seq : null,
    };
  }

  rebuildTrajectoryIndex(missionId) {
    const mission = this.getMission(missionId, { eventLimit: 500, messageLimit: 500, artifactLimit: 500 });
    if (!mission) throw new Error("Mission not found");
    const sourceSignature = JSON.stringify({
      mission: [mission.updatedAt, mission.status, mission.sourcePrompt],
      tasks: mission.tasks.map((task) => [task.id, task.updatedAt, task.status, task.activeTurnId]),
      artifacts: mission.artifacts.map((artifact) => [artifact.id, artifact.createdAt, artifact.verificationStatus]),
      messages: mission.messages.map((message) => [message.id, message.createdAt, message.deliveryStatus]),
      events: mission.events.map((event) => [event.seq, event.createdAt]),
      runs: mission.runs.map((run) => [run.id, run.updatedAt, run.status]),
    });
    const indexed = this.#all(`SELECT * FROM trajectory_index_state WHERE mission_id=${quote(missionId)} LIMIT 1;`)[0];
    if (indexed?.source_signature === sourceSignature) {
      const counts = this.#all(`SELECT (SELECT COUNT(*) FROM trajectory_nodes WHERE mission_id=${quote(missionId)}) AS nodes, (SELECT COUNT(*) FROM trajectory_edges WHERE mission_id=${quote(missionId)}) AS edges;`)[0] || {};
      return { missionId, nodes: Number(counts.nodes || 0), edges: Number(counts.edges || 0), indexedAt: indexed.indexed_at, cacheHit: true };
    }
    const now = new Date().toISOString();
    const nodes = [];
    const edges = [];
    const taskRef = new Map();
    const addNode = (node) => nodes.push({
      id: randomUUID(), taskId: null, filePath: null, sourceId: null, confidence: "reported", content: "", createdAt: now, updatedAt: now, ...node,
    });
    const addEdge = (fromRef, toRef, relation, weight = 1, evidence = []) => edges.push({ id: randomUUID(), fromRef, toRef, relation, weight, evidence, createdAt: now });

    const missionRef = `mission:${mission.id}`;
    addNode({ kind: "mission", title: mission.title, summary: mission.outcome, ref: missionRef, sourceType: "mission", sourceId: mission.id, confidence: "user_verified", content: compactText({ sourcePrompt: mission.sourcePrompt, outcome: mission.outcome, constraints: mission.spec?.constraints || [], acceptance: mission.spec?.acceptanceCriteria || [] }, 2800), createdAt: mission.createdAt, updatedAt: mission.updatedAt });
    for (const task of mission.tasks) {
      const ref = `task:${task.id}`;
      taskRef.set(task.key, ref);
      addNode({ kind: "task", taskId: task.id, title: `${task.key} · ${task.title}`, summary: compactText(task.description, 900), ref, sourceType: "task", sourceId: task.id, confidence: task.status === "completed" ? "user_verified" : "reported", content: compactText({ role: task.agentRole, status: task.status, phase: task.phase, acceptance: task.acceptanceCriteria, result: task.result, evidence: task.evidence, error: task.error }, 3000), createdAt: task.createdAt, updatedAt: task.updatedAt });
      addEdge(missionRef, ref, "assigns", 1);
    }
    for (const task of mission.tasks) {
      const target = taskRef.get(task.key);
      for (const dependency of task.dependencies || []) {
        const source = taskRef.get(dependency);
        if (source && target) addEdge(source, target, "depends_on", 1.2, [`${dependency} -> ${task.key}`]);
      }
    }
    for (const artifact of mission.artifacts) {
      const artifactRef = `artifact:${artifact.id}`;
      addNode({ kind: "artifact", taskId: artifact.taskId, title: artifact.title, summary: compactText(artifact.summary, 1200), ref: artifactRef, sourceType: "artifact", sourceId: artifact.id, confidence: artifact.verificationStatus === "user_verified" ? "user_verified" : artifact.verificationStatus, content: compactText({ files: artifact.files, verification: artifact.verificationStatus, qualityScore: artifact.qualityScore, reportQuality: artifact.reportQuality }, 2200), createdAt: artifact.createdAt, updatedAt: artifact.createdAt });
      const source = mission.tasks.find((task) => task.id === artifact.taskId);
      addEdge(source ? taskRef.get(source.key) : missionRef, artifactRef, "produced", 1.15);
      for (const rawFile of artifact.files || []) {
        const filePath = String(rawFile || "").replace(/^\.\//, "");
        if (!filePath) continue;
        const fileRef = `file:${filePath}`;
        addNode({ kind: "file", taskId: artifact.taskId, title: path.basename(filePath), summary: filePath, ref: fileRef, sourceType: "artifact_file", sourceId: artifact.id, filePath, confidence: artifact.verificationStatus, content: `Published by ${artifact.title}`, createdAt: artifact.createdAt, updatedAt: artifact.createdAt });
        addEdge(artifactRef, fileRef, "contains", 1.1);
        this.#exec(`INSERT INTO file_identities (id,workspace_path,file_path,last_seen_commit,path_history_json,updated_at)
          VALUES (${quote(randomUUID())},${quote(mission.cwd)},${quote(filePath)},NULL,${json([filePath])},${quote(now)})
          ON CONFLICT(workspace_path,file_path) DO UPDATE SET updated_at=excluded.updated_at;`);
      }
    }
    for (const message of mission.messages) {
      const ref = `message:${message.id}`;
      addNode({ kind: "message", title: `${message.fromAgent} → ${message.toAgent}`, summary: compactText(message.text, 1400), ref, sourceType: "bus_message", sourceId: message.id, confidence: message.source === "user" ? "user_verified" : "reported", content: compactText({ topic: message.topic, type: message.messageType, delivery: message.deliveryStatus, source: message.source }, 800), createdAt: message.createdAt, updatedAt: message.createdAt });
      addEdge(missionRef, ref, "communicates", 0.7);
    }
    for (const event of mission.events) {
      const ref = `event:${event.seq}`;
      addNode({ kind: "event", taskId: event.taskId, title: event.type, summary: compactText(event.payload, 1200), ref, sourceType: "event", sourceId: String(event.seq), confidence: "observed", content: compactText(event.payload, 2600), createdAt: event.createdAt, updatedAt: event.createdAt });
      const task = mission.tasks.find((item) => item.id === event.taskId);
      addEdge(task ? taskRef.get(task.key) : missionRef, ref, "observed", 0.55);
    }
    for (const run of mission.runs) {
      const ref = `run:${run.id}`;
      addNode({ kind: "run", taskId: run.taskId, title: `${run.phase} · ${run.status}`, summary: run.error || `${run.triggerType} · attempt ${run.attempt}`, ref, sourceType: "run", sourceId: run.id, confidence: "observed", content: compactText(run, 1200), createdAt: run.createdAt, updatedAt: run.updatedAt });
      const task = mission.tasks.find((item) => item.id === run.taskId);
      addEdge(task ? taskRef.get(task.key) : missionRef, ref, "ran", 0.65);
    }

    const dedupedNodes = [...new Map(nodes.map((node) => [node.ref, node])).values()];
    const dedupedEdges = [...new Map(edges.map((edge) => [`${edge.fromRef}:${edge.toRef}:${edge.relation}`, edge])).values()];
    const statements = [
      `DELETE FROM trajectory_edges WHERE mission_id=${quote(missionId)};`,
      `DELETE FROM trajectory_nodes WHERE mission_id=${quote(missionId)};`,
      ...dedupedNodes.map((node) => `INSERT INTO trajectory_nodes (id,mission_id,task_id,kind,title,summary,ref,source_type,source_id,file_path,content,confidence,created_at,updated_at)
        VALUES (${quote(node.id)},${quote(missionId)},${quote(node.taskId)},${quote(node.kind)},${quote(node.title)},${quote(node.summary)},${quote(node.ref)},${quote(node.sourceType)},${quote(node.sourceId)},${quote(node.filePath)},${quote(node.content)},${quote(node.confidence)},${quote(node.createdAt)},${quote(node.updatedAt)});`),
      ...dedupedEdges.map((edge) => `INSERT INTO trajectory_edges (id,mission_id,from_ref,to_ref,relation,weight,evidence_json,created_at)
        VALUES (${quote(edge.id)},${quote(missionId)},${quote(edge.fromRef)},${quote(edge.toRef)},${quote(edge.relation)},${quote(edge.weight)},${json(edge.evidence)},${quote(edge.createdAt)});`),
      `INSERT INTO trajectory_index_state (mission_id,source_signature,indexed_at) VALUES (${quote(missionId)},${quote(sourceSignature)},${quote(now)}) ON CONFLICT(mission_id) DO UPDATE SET source_signature=excluded.source_signature,indexed_at=excluded.indexed_at;`,
    ];
    this.#transaction(statements);
    return { missionId, nodes: dedupedNodes.length, edges: dedupedEdges.length, indexedAt: now };
  }

  trajectorySearch(input = {}) {
    const missionId = input.missionId;
    if (!missionId) throw new Error("missionId is required");
    const index = this.rebuildTrajectoryIndex(missionId);
    const limit = Math.max(1, Math.min(40, Number(input.limit || 12)));
    const query = compactText(input.query || "", 260).toLowerCase();
    const terms = query.split(/[\s,，。;；:：/\\|]+/).filter((term) => term.length > 1).slice(0, 12);
    const taskId = input.taskId || null;
    const rows = this.#all(`SELECT * FROM trajectory_nodes WHERE mission_id=${quote(missionId)}${taskId ? ` AND (task_id=${quote(taskId)} OR kind='mission')` : ""} ORDER BY updated_at DESC LIMIT 1200;`);
    const edgeRows = this.#all(`SELECT from_ref,to_ref,relation FROM trajectory_edges WHERE mission_id=${quote(missionId)};`);
    const links = new Map();
    for (const edge of edgeRows) {
      if (!links.has(edge.from_ref)) links.set(edge.from_ref, []);
      if (!links.has(edge.to_ref)) links.set(edge.to_ref, []);
      links.get(edge.from_ref).push({ ref: edge.to_ref, relation: edge.relation });
      links.get(edge.to_ref).push({ ref: edge.from_ref, relation: edge.relation });
    }
    const ranked = rows.map((row) => {
      const node = this.#trajectoryNode(row);
      const haystack = trajectoryText(node).toLowerCase();
      let score = taskId && node.taskId === taskId ? 24 : 0;
      const reasons = [];
      if (!query) { score += node.kind === "artifact" ? 14 : node.kind === "task" ? 11 : 4; reasons.push("最近的 Mission 记录"); }
      for (const term of terms) {
        if (node.filePath?.toLowerCase().includes(term)) { score += 34; reasons.push("命中文件路径"); }
        if (node.ref.toLowerCase().includes(term)) { score += 25; reasons.push("命中可追溯引用"); }
        if (node.title.toLowerCase().includes(term)) { score += 20; reasons.push("命中标题"); }
        if (node.summary.toLowerCase().includes(term)) { score += 10; reasons.push("命中摘要"); }
        if (haystack.includes(term)) { score += 4; }
      }
      if (node.confidence === "user_verified") score += 7;
      if (node.kind === "artifact") score += 3;
      return { ...node, score, reasons: [...new Set(reasons)], linkedRefs: links.get(node.ref) || [] };
    }).filter((item) => !query || item.score > 0).sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
    return { query, taskId, items: ranked, stats: { searched: rows.length, returned: ranked.length, indexedNodes: index.nodes, indexedEdges: index.edges, indexedAt: index.indexedAt } };
  }

  contextBrief(input = {}) {
    const missionId = input.missionId;
    if (!missionId) throw new Error("missionId is required");
    const mission = this.getMission(missionId, { eventLimit: 500, messageLimit: 500, artifactLimit: 500 });
    if (!mission) throw new Error("Mission not found");
    const task = input.taskId ? mission.tasks.find((item) => item.id === input.taskId) : null;
    const budget = Math.max(900, Math.min(12000, Number(input.tokenBudget || 4200)));
    const query = input.query || [task?.title, task?.description, ...(task?.dependencies || [])].filter(Boolean).join(" ");
    const search = this.trajectorySearch({ missionId, taskId: null, query, limit: 32 });
    const dependencyTasks = (task?.dependencies || []).map((key) => mission.tasks.find((item) => item.key === key)).filter(Boolean);
    const stableContract = {
      title: mission.title,
      outcome: mission.outcome,
      scope: mission.spec?.scope || [],
      constraints: mission.spec?.constraints || [],
      acceptanceCriteria: mission.spec?.acceptanceCriteria || [],
    };
    const candidates = [];
    if (task) candidates.push({ type: "assigned_task", priority: 1000, ref: `task:${task.id}`, title: `${task.key} · ${task.title}`, text: compactText({ description: task.description, acceptance: task.acceptanceCriteria, status: task.status }, 2200), reason: "当前 Worker 的任务契约" });
    for (const dependency of dependencyTasks) candidates.push({ type: "dependency_checkpoint", priority: 900, ref: `task:${dependency.id}`, title: `${dependency.key} · ${dependency.title}`, text: compactText({ result: dependency.result, evidence: dependency.evidence, status: dependency.status, error: dependency.error }, 2200), reason: "上游依赖的可验证检查点" });
    for (const item of search.items) candidates.push({ type: item.kind, priority: 35 + Math.min(60, item.score), ref: item.ref, title: item.title, text: compactText([item.summary, item.content, item.filePath].filter(Boolean).join("\n"), 1800), reason: item.reasons.join("、") || "与当前任务的本地轨迹相关" });
    const selected = [];
    const seen = new Set();
    let used = estimateTokens(JSON.stringify(stableContract));
    for (const candidate of candidates.sort((a, b) => b.priority - a.priority)) {
      if (seen.has(candidate.ref) || !candidate.text) continue;
      const cost = estimateTokens(`${candidate.title}\n${candidate.text}`);
      if (selected.length && used + cost > budget) continue;
      seen.add(candidate.ref); used += cost;
      selected.push({ ...candidate, estimatedTokens: cost });
    }
    const allRows = this.#all(`SELECT title,summary,ref,file_path,content FROM trajectory_nodes WHERE mission_id=${quote(missionId)};`);
    const baselineTokens = estimateTokens(`${JSON.stringify(stableContract)}\n${allRows.map((row) => trajectoryText({ title: row.title, summary: row.summary, ref: row.ref, filePath: row.file_path, content: row.content })).join("\n")}`);
    const dependencyCheckpoints = selected.filter((item) => item.type === "dependency_checkpoint");
    const evidence = selected.filter((item) => item.type !== "assigned_task" && item.type !== "dependency_checkpoint");
    const runtimePrompt = `CONTEXT KERNEL · LOCAL, BUDGETED, TRACEABLE\nUse these Mission facts as context. Do not re-read unrelated files or replay raw conversations unless the task actually requires it.\n\nMISSION CONTRACT\n${compactText(stableContract, 2600)}\n\n${task ? `ASSIGNED TASK\n${selected.find((item) => item.type === "assigned_task")?.text || task.description}\n\n` : ""}DEPENDENCY CHECKPOINTS\n${dependencyCheckpoints.map((item) => `- ${item.title}: ${item.text}`).join("\n") || "- No completed dependency checkpoint is needed."}\n\nRETRIEVED EVIDENCE\n${evidence.map((item) => `- [${item.ref}] ${item.title}: ${item.text}`).join("\n") || "- No additional evidence was selected."}\n\nCONTEXT RULE\nTreat this capsule as a projection of the local Mission ledger. When it conflicts with the repository, verify with the repository and publish the corrected evidence.`;
    return {
      missionId, taskId: task?.id || null, query: compactText(query, 260), stableContract, task: task ? { id: task.id, key: task.key, title: task.title } : null,
      dependencyCheckpoints, evidence, runtimePrompt,
      stats: {
        tokenBudget: budget, estimatedTokens: used, baselineEstimatedTokens: baselineTokens,
        estimatedSavedTokens: Math.max(0, baselineTokens - used), reductionPercent: baselineTokens ? Math.max(0, Math.round((1 - used / baselineTokens) * 100)) : 0,
        candidates: candidates.length, included: selected.length, withheld: Math.max(0, candidates.length - selected.length), indexedNodes: search.stats.indexedNodes, indexedEdges: search.stats.indexedEdges,
      },
    };
  }

  close() {
    if (this.database?.open) this.database.close();
  }

  #snapshot(row, options = {}) {
    // The inspector refreshes on every real Codex event. Keep the live snapshot
    // small; the Activity view pages older records through listEvents().
    const eventLimit = Math.max(1, Math.min(500, Number(options.eventLimit || 40)));
    const messageLimit = Math.max(1, Math.min(500, Number(options.messageLimit || 100)));
    const artifactLimit = Math.max(1, Math.min(500, Number(options.artifactLimit || 100)));
    const mission = this.#mission(row);
    mission.tasks = this.#all(`SELECT * FROM tasks WHERE mission_id=${quote(row.id)} ORDER BY created_at,task_key;`).map((item) => this.#task(item));
    mission.agents = [
      { id: `${row.id}:main`, missionId: row.id, kind: "planner", name: "Main Agent", role: "Planner", taskId: null, threadId: mission.mainThreadId, status: mission.status },
      ...mission.tasks.map((task) => ({ id: `${row.id}:${task.key}`, missionId: row.id, kind: "worker", name: task.agentRole, role: task.agentRole, taskId: task.id, taskKey: task.key, threadId: task.agentThreadId, status: task.status })),
    ];
    mission.tasks = mission.tasks.map((task) => ({ ...task, agentId: `${row.id}:${task.key}` }));
    mission.runs = this.#all(`SELECT * FROM mission_runs WHERE mission_id=${quote(row.id)} ORDER BY started_at DESC;`).map((item) => this.#runRecord(item));
    const ui = this.#all(`SELECT * FROM mission_ui_state WHERE mission_id=${quote(row.id)} LIMIT 1;`)[0];
    mission.uiState = ui ? {
      layout: parseJson(ui.layout_json, {}), viewport: parseJson(ui.viewport_json, null),
      panels: parseJson(ui.panels_json, {}), updatedAt: ui.updated_at,
    } : { layout: {}, viewport: null, panels: {}, updatedAt: null };
    const events = this.#all(`SELECT * FROM mission_events WHERE mission_id=${quote(row.id)} ORDER BY seq DESC LIMIT ${eventLimit + 1};`);
    mission.events = events.slice(0, eventLimit).map((item) => this.#event(item));
    mission.hasMoreEvents = events.length > eventLimit;
    mission.messages = this.#all(`SELECT * FROM bus_messages WHERE mission_id=${quote(row.id)} ORDER BY created_at DESC LIMIT ${messageLimit};`).map((item) => this.#message(item));
    mission.artifacts = this.#all(`SELECT * FROM artifacts WHERE mission_id=${quote(row.id)} ORDER BY created_at DESC LIMIT ${artifactLimit};`).map((item) => this.#artifact(item));
    return mission;
  }

  #event(item) {
    return {
      seq: item.seq, missionId: item.mission_id, taskId: item.task_id, threadId: item.thread_id,
      type: item.event_type, payload: parseJson(item.payload_json, {}), createdAt: item.created_at,
    };
  }

  #message(item) {
    return {
      id: item.id, missionId: item.mission_id, fromAgent: item.from_agent, toAgent: item.to_agent,
      topic: item.topic, messageType: item.message_type, text: item.text, deliveryStatus: item.delivery_status,
      error: item.error || null, source: item.source, providerItemId: item.provider_item_id, createdAt: item.created_at,
    };
  }

  #artifact(item) {
    return {
      id: item.id, missionId: item.mission_id, taskId: item.task_id, title: item.title, summary: item.summary,
      files: parseJson(item.files_json, []).map((file) => decodeGitPath(file)), verificationStatus: item.verification_status,
      sourceThreadId: item.source_thread_id, qualityScore: item.quality_score == null ? null : Number(item.quality_score),
      reportQuality: parseJson(item.quality_json, null), createdAt: item.created_at,
    };
  }

  #trajectoryNode(row) {
    return {
      id: row.id, missionId: row.mission_id, taskId: row.task_id, kind: row.kind, title: row.title, summary: row.summary,
      ref: row.ref, sourceType: row.source_type, sourceId: row.source_id, filePath: row.file_path, content: row.content,
      confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  #runRecord(row) {
    return {
      id: row.id, missionId: row.mission_id, taskId: row.task_id, agentId: row.agent_id,
      threadId: row.thread_id, turnId: row.turn_id, status: row.status, phase: row.phase,
      attempt: Number(row.attempt || 1), triggerType: row.trigger_type, error: row.error,
      startedAt: row.started_at, endedAt: row.ended_at, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  #mission(row) {
    return {
      id: row.id, title: row.title, outcome: row.outcome, sourcePrompt: row.source_prompt, cwd: row.cwd,
      provider: row.provider, model: row.model, status: row.status, maxWorkers: row.max_workers,
      mainThreadId: row.main_thread_id, activeTurnId: row.active_turn_id,
      executionMode: row.execution_mode || "code", executionCwd: row.execution_cwd || null,
      spec: parseJson(row.spec_json, null), valueContract: normalizeValueContract(parseJson(row.value_contract_json, {})), error: row.error,
      integrationPath: row.integration_path, integrationBranch: row.integration_branch, integrationCommit: row.integration_commit,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  #requirement(row) {
    return {
      id: row.id, title: row.title, outcome: row.outcome, body: row.body,
      sourceType: row.source_type, sourceRef: row.source_ref, workspacePath: row.workspace_path,
      executionMode: row.execution_mode || "code",
      priority: row.priority, status: row.status, labels: parseJson(row.labels_json, []), acceptanceCriteria: parseJson(row.acceptance_json, []), valueContract: normalizeValueContract(parseJson(row.value_contract_json, {})),
      missionId: row.mission_id, missionStatus: row.mission_status || null, missionTitle: row.mission_title || null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  #task(row) {
    return {
      id: row.id, missionId: row.mission_id, key: row.task_key, title: row.title, description: row.description,
      agentRole: row.agent_role, status: row.status, phase: row.phase,
      dependencies: parseJson(row.dependencies_json, []), acceptanceCriteria: parseJson(row.acceptance_json, []),
      value: parseJson(row.value_json, { score: 3, estimatedTokenBudget: 6000, rationale: "未标注价值假设" }),
      result: parseJson(row.result_json, null), evidence: parseJson(row.evidence_json, []),
      agentThreadId: row.agent_thread_id, activeTurnId: row.active_turn_id,
      worktreePath: row.worktree_path, branch: row.branch, commitHash: row.commit_hash, error: row.error,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  #transaction(statements) {
    this.#exec(`BEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;`);
  }

  #ensureColumn(table, column, definition) {
    const columns = this.#all(`PRAGMA table_info(${table});`);
    if (!columns.some((item) => item.name === column)) this.#exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  #all(sqlText) {
    if (this.database) return this.database.prepare(sqlText).all();
    const result = this.#run(["-json", this.databasePath], `.timeout 5000\nPRAGMA foreign_keys=ON;\n${sqlText}`, "SQLite query failed");
    const output = result.stdout.trim();
    if (!output) return [];
    try { return JSON.parse(output); }
    catch (error) { throw new Error(`SQLite returned invalid JSON: ${error.message}`); }
  }

  #exec(sqlText) {
    if (this.database) {
      this.database.exec(sqlText);
      return;
    }
    this.#run([this.databasePath], `.timeout 5000\n${sqlText}`, "SQLite write failed");
  }

  #run(args, input, label) {
    let lastResult;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = spawnSync(this.sqliteBinary, args, { input, encoding: "utf8", maxBuffer: SQLITE_MAX_BUFFER });
      if (result.status === 0) return result;
      lastResult = result;
      const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
      const retryable = /database is locked|SQLITE_BUSY|EAGAIN|temporarily unavailable/i.test(detail);
      if (!retryable || attempt === 2) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (attempt + 1));
    }
    const detail = lastResult?.error?.message || lastResult?.stderr?.trim() || lastResult?.stdout?.trim() || `exit ${lastResult?.status}`;
    throw new Error(`${label}: ${detail}`);
  }
}

module.exports = { MissionStore, parseJson };
