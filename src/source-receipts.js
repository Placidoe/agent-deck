export function sourceReceipts(events = [], taskId = null) {
  const selected = new Map();
  for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
    const item = event.payload?.item;
    if (event.taskId !== taskId || event.type !== "provider.item/completed" || item?.server !== "agent-deck-personal" || item.state !== "executed") continue;
    const source = item.source;
    if (!source || !/^[a-f0-9]{64}$/.test(source.sha256 || "")) continue;
    const id = `${source.kind}:${source.url || source.path}:${source.sha256}`;
    if (!selected.has(id)) selected.set(id, { id, ...source });
    if (selected.size >= 20) break;
  }
  return [...selected.values()];
}
