export function buildExecutionContext(state, contract) {
    const references = new Set(contract.contextRefs);
    const evidenceIds = new Set();
    const requirements = state.requirements
        .filter((record) => references.has(record.id))
        .map((record) => structuredClone(record));
    const facts = state.facts
        .filter((record) => references.has(record.id))
        .map((record) => structuredClone(record));
    const artifacts = state.artifacts
        .filter((record) => references.has(record.id))
        .map((record) => structuredClone(record));
    for (const record of [...requirements, ...facts, ...artifacts]) {
        for (const evidenceId of record.evidenceIds)
            evidenceIds.add(evidenceId);
    }
    return {
        runId: state.runId,
        round: state.round,
        originalGoal: state.goal,
        contract: structuredClone(contract),
        requirements,
        facts,
        artifacts,
        evidence: state.evidence
            .filter((record) => references.has(record.id) || evidenceIds.has(record.id))
            .map((record) => structuredClone(record)),
    };
}
//# sourceMappingURL=context.js.map