import { randomUUID } from "node:crypto";
import { buildExecutionContext } from "./context.js";
export class AgentHarness {
    #store;
    #clock;
    #createId;
    constructor(options) {
        this.#store = options.store;
        this.#clock = options.clock ?? (() => new Date());
        this.#createId = options.createId ?? randomUUID;
    }
    async start(input) {
        if (!input.goal.trim())
            throw new Error("A run goal is required.");
        if (input.requirements.length === 0) {
            throw new Error("At least one explicit requirement is required.");
        }
        const runId = input.runId ?? this.#createId();
        if (await this.#store.load(runId)) {
            throw new Error(`Run already exists: ${runId}`);
        }
        const now = this.#now();
        const state = {
            schemaVersion: 1,
            runId,
            goal: input.goal.trim(),
            status: "running",
            round: 0,
            eventSequence: 0,
            createdAt: now,
            updatedAt: now,
            requirements: input.requirements.map((requirement) => ({
                ...requirement,
                status: "pending",
                evidenceIds: [],
            })),
            facts: [],
            artifacts: [],
            evidence: [],
            blockers: [],
            metrics: {
                managerCalls: 0,
                executorCalls: 0,
                auditorCalls: 0,
                managerMs: 0,
                executorMs: 0,
                auditorMs: 0,
            },
        };
        await this.#persist(state, "run.created", { goal: state.goal }, input.onEvent);
        return this.#drive(state, {
            manager: input.manager,
            executor: input.executor,
            auditor: input.auditor,
            maxRounds: input.maxRounds ?? 8,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onEvent ? { onEvent: input.onEvent } : {}),
        });
    }
    async resume(input) {
        const state = await this.#store.load(input.runId);
        if (!state)
            throw new Error(`Unknown run: ${input.runId}`);
        if (state.status === "completed")
            return state;
        const persistedEvents = await this.#store.readEvents(input.runId);
        state.eventSequence = Math.max(state.eventSequence, persistedEvents.at(-1)?.sequence ?? 0);
        state.status = "running";
        delete state.attention;
        state.updatedAt = this.#now();
        await this.#persist(state, "run.resumed", input.note ? { note: input.note } : {}, input.onEvent);
        return this.#drive(state, {
            manager: input.manager,
            executor: input.executor,
            auditor: input.auditor,
            maxRounds: input.maxRounds ?? 8,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onEvent ? { onEvent: input.onEvent } : {}),
        });
    }
    async get(runId) {
        return this.#store.load(runId);
    }
    async #drive(state, options) {
        let executedRounds = 0;
        // Permit the final manager decision after the last allowed execution. A
        // successful audit on the final round must not become budget_exhausted.
        while (true) {
            if (options.signal?.aborted) {
                state.status = "canceled";
                state.updatedAt = this.#now();
                await this.#persist(state, "run.canceled", {}, options.onEvent);
                return state;
            }
            const managerStarted = performance.now();
            const decision = await options.manager.decide({ state: structuredClone(state) });
            state.metrics.managerCalls += 1;
            state.metrics.managerMs += performance.now() - managerStarted;
            await this.#persist(state, "manager.decided", { decision: this.#decisionEventData(decision) }, options.onEvent);
            if (decision.type === "ask") {
                state.status = "needs_input";
                state.attention = {
                    type: "ask",
                    title: decision.question,
                    detail: decision.reason,
                    ...(decision.suggestedResponses
                        ? { suggestedResponses: decision.suggestedResponses }
                        : {}),
                };
                await this.#requireAttention(state, options.onEvent);
                return state;
            }
            if (decision.type === "blocked") {
                this.#upsertById(state.blockers, decision.blocker);
                state.status = "blocked";
                state.attention = {
                    type: "blocked",
                    title: decision.blocker.summary,
                    detail: decision.blocker.detail ?? decision.blocker.summary,
                    ...(decision.blocker.suggestedAction
                        ? { suggestedAction: decision.blocker.suggestedAction }
                        : {}),
                };
                await this.#requireAttention(state, options.onEvent);
                return state;
            }
            if (decision.type === "done") {
                if (this.#canComplete(state)) {
                    state.status = "completed";
                    state.completionSummary = decision.summary;
                    delete state.activeContract;
                    delete state.attention;
                    state.updatedAt = this.#now();
                    await this.#persist(state, "run.completed", { summary: decision.summary }, options.onEvent);
                    return state;
                }
                state.status = "blocked";
                state.attention = {
                    type: "invalid_completion",
                    title: "Completion was not verified",
                    detail: "The manager requested completion while requirements remain pending, blocked, or untrusted.",
                    suggestedAction: "Inspect the unmet requirements and continue with a bounded repair contract.",
                };
                await this.#requireAttention(state, options.onEvent);
                return state;
            }
            if (executedRounds >= options.maxRounds)
                break;
            state.round += 1;
            executedRounds += 1;
            state.activeContract = structuredClone(decision.contract);
            state.status = "running";
            state.updatedAt = this.#now();
            const context = buildExecutionContext(state, decision.contract);
            await this.#persist(state, "executor.started", { contractId: decision.contract.id, round: state.round }, options.onEvent);
            const executorStarted = performance.now();
            const execution = await options.executor.execute({
                context,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            state.metrics.executorCalls += 1;
            state.metrics.executorMs += performance.now() - executorStarted;
            state.lastExecution = structuredClone(execution);
            await this.#persist(state, "executor.finished", {
                contractId: decision.contract.id,
                claimedComplete: execution.claimedComplete,
                summary: execution.summary,
            }, options.onEvent);
            await this.#persist(state, "auditor.started", { contractId: decision.contract.id, round: state.round }, options.onEvent);
            const auditorStarted = performance.now();
            const audit = await options.auditor.audit({
                state: structuredClone(state),
                context,
                execution: structuredClone(execution),
                ...(options.signal ? { signal: options.signal } : {}),
            });
            state.metrics.auditorCalls += 1;
            state.metrics.auditorMs += performance.now() - auditorStarted;
            state.lastAudit = structuredClone(audit);
            this.#applyAudit(state, audit);
            await this.#persist(state, "auditor.finished", {
                contractId: decision.contract.id,
                outcome: audit.outcome,
                integrity: audit.integrity,
                summary: audit.summary,
            }, options.onEvent);
            await this.#persist(state, "state.updated", { round: state.round }, options.onEvent);
            if (audit.outcome === "blocked" || audit.integrity === "violation") {
                state.status = "blocked";
                state.attention = {
                    type: "blocked",
                    title: "Execution requires intervention",
                    detail: audit.summary,
                    suggestedAction: "Review the audit evidence and choose a bounded recovery action.",
                };
                await this.#requireAttention(state, options.onEvent);
                return state;
            }
        }
        state.status = "budget_exhausted";
        state.attention = {
            type: "budget_exhausted",
            title: "Execution budget exhausted",
            detail: `The run reached its ${options.maxRounds}-round budget without verified completion.`,
            suggestedAction: "Review progress before granting another bounded execution budget.",
        };
        await this.#requireAttention(state, options.onEvent);
        return state;
    }
    #applyAudit(state, audit) {
        for (const evidence of audit.evidence)
            this.#upsertById(state.evidence, evidence);
        const availableEvidence = new Set(state.evidence.map((record) => record.id));
        const clean = audit.integrity === "clean";
        for (const update of audit.requirementUpdates ?? []) {
            const requirement = state.requirements.find((record) => record.id === update.id);
            if (!requirement)
                continue;
            const evidenceIsValid = update.evidenceIds.length > 0 &&
                update.evidenceIds.every((evidenceId) => availableEvidence.has(evidenceId));
            requirement.status = clean && evidenceIsValid ? update.status : "untrusted";
            requirement.evidenceIds = [...update.evidenceIds];
        }
        for (const fact of audit.facts ?? []) {
            const evidenceIsValid = fact.evidenceIds.length > 0 &&
                fact.evidenceIds.every((evidenceId) => availableEvidence.has(evidenceId));
            this.#upsertById(state.facts, {
                ...fact,
                status: clean && evidenceIsValid ? fact.status : "untrusted",
            });
        }
        for (const artifact of audit.artifacts ?? []) {
            const evidenceIsValid = artifact.evidenceIds.length > 0 &&
                artifact.evidenceIds.every((evidenceId) => availableEvidence.has(evidenceId));
            this.#upsertById(state.artifacts, {
                ...artifact,
                status: clean && evidenceIsValid ? artifact.status : "untrusted",
            });
        }
        for (const blocker of audit.blockers ?? [])
            this.#upsertById(state.blockers, blocker);
        state.updatedAt = this.#now();
    }
    #canComplete(state) {
        return (state.requirements.every((requirement) => requirement.status === "completed") &&
            state.blockers.length === 0 &&
            state.lastAudit?.integrity === "clean");
    }
    async #requireAttention(state, onEvent) {
        state.updatedAt = this.#now();
        await this.#persist(state, "attention.required", { attention: state.attention ?? null }, onEvent);
    }
    async #persist(state, type, data, onEvent) {
        state.updatedAt = this.#now();
        const sequence = state.eventSequence + 1;
        const event = {
            id: this.#createId(),
            runId: state.runId,
            sequence,
            occurredAt: state.updatedAt,
            type,
            data,
        };
        state.eventSequence = sequence;
        await this.#store.commit(state, event);
        await onEvent?.(structuredClone(event));
    }
    #decisionEventData(decision) {
        switch (decision.type) {
            case "execute":
                return { type: decision.type, contractId: decision.contract.id };
            case "done":
                return { type: decision.type, summary: decision.summary };
            case "ask":
                return { type: decision.type, question: decision.question };
            case "blocked":
                return { type: decision.type, blockerId: decision.blocker.id };
        }
    }
    #upsertById(records, value) {
        const index = records.findIndex((record) => record.id === value.id);
        if (index === -1)
            records.push(structuredClone(value));
        else
            records[index] = structuredClone(value);
    }
    #now() {
        return this.#clock().toISOString();
    }
}
//# sourceMappingURL=harness.js.map