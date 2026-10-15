import { HOUR, MINUTE } from '../../engine/time.mjs';
import { CopilotHome } from './copilot-home.mjs';
import { EventLog } from './event-log.mjs';

export const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
export const DAY = 24 * HOUR;
export const at = minutes => T0 + minutes * MINUTE;
export const alwaysAlive = async locks => new Map(locks.map(lock => [lock.pid, true]));

/** A live synthetic swarm (root with an open tagged question, two idle units) and a finished one from 30 days earlier. */
export function scenario() {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root', branch: 'main' });
  home.workspace({ id: 'ws-api', projectId: 'project-1', name: 'Sample a1 api', createdAt: at(5), sessionId: 'cli-api', parentId: 'ws-root', creatorSessionId: 'cli-root', branch: 'feature/api', baseBranch: 'main' });
  home.workspace({ id: 'ws-ui', projectId: 'project-1', name: 'Sample u1 ui', createdAt: at(6), sessionId: 'cli-ui', parentId: 'ws-root', creatorSessionId: 'cli-root', branch: 'feature/ui', baseBranch: 'feature/api' });
  home.workspace({ id: 'ws-old', name: 'Old swarm', createdAt: T0 - 30 * DAY, sessionId: 'cli-old' });
  home.workspace({ id: 'ws-old-child', name: 'Old child', createdAt: T0 - 30 * DAY + MINUTE, sessionId: 'cli-old-child', parentId: 'ws-old', creatorSessionId: 'cli-old' });

  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.wait(MINUTE); root.turnEnd();
  root.at(at(50)); root.turnStart(); root.ask('[unit=a1] Ship the API?');
  home.writeEvents('cli-root', root.events);
  const api = new EventLog(at(5));
  api.start(); api.turnStart(); api.at(at(20));
  api.report('ws-root', 'swarm-status: complete unit=a1\nSummary: API done.', 'handoff');
  api.turnEnd();
  home.writeEvents('cli-api', api.events);
  const ui = new EventLog(at(6));
  ui.start(); ui.turnStart(); ui.at(at(30)); ui.turnEnd();
  home.writeEvents('cli-ui', ui.events);
  const old = new EventLog(T0 - 30 * DAY);
  old.start(); old.turnStart(); old.wait(MINUTE); old.turnEnd();
  home.writeEvents('cli-old', old.events);

  home.usage([{ sessionId: 'cli-root', nanoAiu: 3e9, createdAt: at(1) }, { sessionId: 'cli-api', nanoAiu: 4e9, createdAt: at(20) }]);
  home.lock('cli-root', 101, T0);
  home.lock('cli-api', 102, at(5));
  home.lock('cli-ui', 103, at(6));
  home.sessionDb('cli-api', { todos: [{ id: 'a', status: 'done' }, { id: 'b' }] });
  home.workspaceYaml('cli-api', { cwd: '/synthetic/worktrees/api', branch: 'feature/api' });
  return home;
}
