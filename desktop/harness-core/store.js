import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
function clone(value) {
    return structuredClone(value);
}
function assertRunId(runId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
        throw new Error(`Invalid run id: ${runId}`);
    }
}
export class MemoryRunStore {
    #states = new Map();
    #events = new Map();
    async load(runId) {
        const state = this.#states.get(runId);
        return state ? clone(state) : undefined;
    }
    async save(state) {
        this.#states.set(state.runId, clone(state));
    }
    async append(event) {
        const events = this.#events.get(event.runId) ?? [];
        events.push(clone(event));
        this.#events.set(event.runId, events);
    }
    async commit(state, event) {
        const events = this.#events.get(event.runId) ?? [];
        events.push(clone(event));
        this.#events.set(event.runId, events);
        this.#states.set(state.runId, clone(state));
    }
    async readEvents(runId) {
        return clone(this.#events.get(runId) ?? []);
    }
}
export class JsonFileRunStore {
    rootDirectory;
    constructor(rootDirectory) {
        this.rootDirectory = rootDirectory;
    }
    async load(runId) {
        assertRunId(runId);
        try {
            const raw = await readFile(this.#snapshotPath(runId), "utf8");
            return JSON.parse(raw);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async save(state) {
        assertRunId(state.runId);
        const directory = this.#runDirectory(state.runId);
        await mkdir(directory, { recursive: true });
        const target = this.#snapshotPath(state.runId);
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await rename(temporary, target);
    }
    async append(event) {
        assertRunId(event.runId);
        const directory = this.#runDirectory(event.runId);
        await mkdir(directory, { recursive: true });
        await appendFile(this.#eventPath(event.runId), `${JSON.stringify(event)}\n`, "utf8");
    }
    async commit(state, event) {
        await this.append(event);
        await this.save(state);
    }
    async readEvents(runId) {
        assertRunId(runId);
        try {
            const raw = await readFile(this.#eventPath(runId), "utf8");
            return raw
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
    }
    #runDirectory(runId) {
        return join(this.rootDirectory, "runs", runId);
    }
    #snapshotPath(runId) {
        return join(this.#runDirectory(runId), "snapshot.json");
    }
    #eventPath(runId) {
        return join(this.#runDirectory(runId), "events.jsonl");
    }
}
//# sourceMappingURL=store.js.map