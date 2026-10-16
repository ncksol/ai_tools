/**
 * In-memory SwarmEngine for server and UI development and tests. It serves fixed snapshots and history
 * through the same API as createSwarmEngine() and never reads Copilot data.
 */
export function createFakeEngine({ snapshots = [], swarms = null, history = [], summaries = [] } = {}) {
  history = structuredClone(history);
  summaries = structuredClone(summaries);
  const byId = new Map(snapshots.map(snapshot => [snapshot.run.id, structuredClone(snapshot)]));
  const toItem = snapshot => ({
    id: snapshot.run.id, name: snapshot.run.name, project: snapshot.run.project, startedAt: snapshot.run.startedAt,
    lastActivityAt: snapshot.run.lastActivityAt, lifecycle: snapshot.run.lifecycle,     units: snapshot.units.filter(unit => unit.kind !== 'subagent').length,
    credits: snapshot.cost.credits, alive: snapshot.run.lifecycle === 'live',
  });
  // Live swarms first, then most recently active first, as the real engine sorts listSwarms().
  const compare = (a, b) => (a.lifecycle === b.lifecycle ? b.lastActivityAt - a.lastActivityAt : a.lifecycle === 'live' ? -1 : 1);
  const list = swarms ? structuredClone(swarms) : snapshots.map(toItem);
  list.sort(compare);
  const listeners = new Set();
  let revision = 0;
  return {
    async refresh() {},
    start() {},
    stop() {},
    listSwarms: () => structuredClone(list),
    async getSnapshot(swarmId) {
      const id = swarmId ?? list[0]?.id;
      return byId.has(id) ? structuredClone(byId.get(id)) : null;
    },
    async findSwarm(sessionId) {
      for (const snapshot of byId.values()) {
        // Sub-agent unit ids are tool-call ids, not session ids; the real engine ignores them too.
        const sessions = [snapshot.orchestrator, ...snapshot.units.filter(unit => unit.kind !== 'subagent')];
        if (snapshot.run.id === sessionId || sessions.some(session => session.id === sessionId || session.cliSessionIds.includes(sessionId))) {
          return snapshot.run.id;
        }
      }
      return null;
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
      const fresh = toItem(snapshot);
      const entry = list.find(swarm => swarm.id === fresh.id);
      if (entry) {
        const { alive } = entry;
        Object.assign(entry, fresh, { alive });
      } else {
        list.push(fresh);
      }
      list.sort(compare);
      revision += 1;
      for (const listener of listeners) listener({ revision, swarmIds: [snapshot.run.id] });
    },
  };
}
