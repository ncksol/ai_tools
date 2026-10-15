/**
 * In-memory SwarmEngine for server and UI development and tests. It serves fixed snapshots and history
 * through the same API as createSwarmEngine() and never reads Copilot data.
 */
export function createFakeEngine({ snapshots = [], swarms = null, history = [], summaries = [] } = {}) {
  const byId = new Map(snapshots.map(snapshot => [snapshot.run.id, structuredClone(snapshot)]));
  const list = swarms ?? snapshots.map(snapshot => ({
    id: snapshot.run.id, name: snapshot.run.name, project: snapshot.run.project, startedAt: snapshot.run.startedAt,
    lastActivityAt: snapshot.run.lastActivityAt, lifecycle: snapshot.run.lifecycle, units: snapshot.units.length,
    credits: snapshot.cost.credits, alive: snapshot.run.lifecycle === 'live',
  }));
  const listeners = new Set();
  let revision = 0;
  return {
    async refresh() {},
    start() {},
    stop() {},
    listSwarms: () => structuredClone(list),
    async getSnapshot(swarmId) {
      const id = swarmId ?? list.find(swarm => swarm.lifecycle === 'live')?.id ?? list[0]?.id;
      return byId.has(id) ? structuredClone(byId.get(id)) : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listHistory() {
      return structuredClone(history);
    },
    async getRunSummary(runId) {
      const summary = summaries.find(item => item.id === runId);
      return summary ? structuredClone(summary) : null;
    },
    diagnostics: () => [],
    /** Replace one snapshot and notify subscribers, as a real refresh would. */
    push(snapshot) {
      byId.set(snapshot.run.id, structuredClone(snapshot));
      revision += 1;
      for (const listener of listeners) listener({ revision, swarmIds: [snapshot.run.id] });
    },
  };
}
