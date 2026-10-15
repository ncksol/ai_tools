export class EventLog {
  constructor(start) {
    this.t = start;
    this.events = [];
    this.count = 0;
    this.calls = 0;
    this.previous = null;
  }

  at(ms) { this.t = ms; }

  wait(ms) { this.t += ms; }

  push(type, data = {}, extra = {}) {
    const id = `ev-${++this.count}`;
    this.events.push({ type, data, ...extra, id, timestamp: new Date(this.t).toISOString(), parentId: this.previous });
    this.previous = id;
    return id;
  }

  start(model = 'claude-sonnet-5') { return this.push('session.start', { copilotVersion: '1.0.95-3', selectedModel: model }); }

  resume() { return this.push('session.resume', { selectedModel: 'claude-sonnet-5' }); }

  turnStart() { return this.push('assistant.turn_start', { turnId: '0', interactionId: 'interaction' }); }

  turnEnd() { return this.push('assistant.turn_end', { turnId: '0' }); }

  message(content = 'ok') { return this.push('assistant.message', { content, model: 'claude-sonnet-5', toolRequests: [] }); }

  usage(model = 'claude-sonnet-5', extra = {}) { return this.push('session.usage_record', { usage: { model, inputTokens: 10, outputTokens: 2 } }, extra); }

  user(content = 'go', data = {}) { return this.push('user.message', { content, transformedContent: content, ...data }); }

  tool(name, args = {}) {
    const id = `call-${++this.calls}`;
    this.push('tool.execution_start', { toolCallId: id, toolName: name, arguments: args });
    return id;
  }

  done(id, { success = true, result = 'ok', telemetry = null } = {}) {
    return this.push('tool.execution_complete', { toolCallId: id, success, result: { content: result }, ...(telemetry ? { toolTelemetry: telemetry } : {}) });
  }

  ask(question, choices) { return this.tool('ask_user', { question, ...(choices ? { choices } : {}) }); }

  plan(summary) { return this.tool('exit_plan_mode', { summary, recommendedAction: 'autopilot' }); }

  report(sessionId, message, purpose) {
    const id = this.tool('send_session_message', { session_id: sessionId, message, ...(purpose ? { purpose } : {}) });
    this.done(id, { result: 'Message accepted for delivery' });
    return id;
  }

  subagent({ name = 'helper', type = 'general-purpose', mode = 'sync', model = 'claude-sonnet-5', effort, agentId } = {}) {
    const id = this.tool('task', {
      name, agent_type: type, mode, model, description: `${name} work`, prompt: 'synthetic prompt',
      ...(effort ? { reasoning_effort: effort } : {}),
    });
    this.push('subagent.started', { toolCallId: id, agentName: type, agentDisplayName: name, agentType: type, model, executionMode: mode }, agentId ? { agentId } : {});
    if (mode === 'background') this.done(id, { result: 'Agent started in background' });
    return id;
  }

  sub(callId, type = 'assistant.message', data = {}) { return this.push(type, { ...data, parentToolCallId: callId }); }

  subagentDone(callId, { durationMs = 60_000, failed = false } = {}) {
    return this.push(failed ? 'subagent.failed' : 'subagent.completed', { toolCallId: callId, durationMs, totalTokens: 1000, totalToolCalls: 3 });
  }

  crossSession({ fromSessionId, fromProjectSessionId = fromSessionId, sourceToolCallId = 'call-remote', name = 'unit', content }) {
    const envelope = [
      '<cross_session_message>',
      `from_project_session_id: ${fromProjectSessionId}`,
      `from_session_id: ${fromSessionId}`,
      `from_project_session_name: ${name}`,
      `from_display_name: ${name}`,
      `source_tool_call_id: ${sourceToolCallId}`,
      '</cross_session_message>',
    ].join('\n');
    return this.push('user.message', {
      content, transformedContent: `<current_datetime>synthetic</current_datetime>\n\n${envelope}\n${content}`,
      source: `agent-${fromSessionId}`, delivery: 'idle',
    });
  }

  automationWake(prompt = 'Check the PR for new comments') {
    return this.push('user.message', { content: prompt, transformedContent: `<session_automation>\n${prompt}\n</session_automation>`, source: 'system', delivery: 'idle' });
  }

  taskComplete(summary, success = true) { return this.push('session.task_complete', { summary, success }); }

  shutdown() { return this.push('session.shutdown', { shutdownType: 'routine' }); }

  abort() { return this.push('abort', { reason: 'user_initiated' }); }

  lines() { return this.events.map(event => JSON.stringify(event)).join('\n') + '\n'; }
}
