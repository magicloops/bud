// Experimental in-process adapter for the canonical AgentService integration.
// No raw CDP, tickets, owner IDs or epochs are exposed as model arguments.
import { randomUUID } from 'node:crypto';

export function createAgentBridge({ sessions, send, end, authorize, persistHandoff }) {
  const turns = new WeakMap();
  const owned = async context => {
    context.signal.throwIfAborted();
    if (!await authorize(context)) throw new Error('browser_not_found');
    context.signal.throwIfAborted();
    const session = sessions.get(context.threadId);
    if (!session || session.ended || session.owner !== context.ownerUserId) throw new Error('browser_not_found');
    return session;
  };
  const lease = (session, context) => {
    let current = turns.get(session);
    if (!current) {
      current = { turn: context.turnId, epoch: session.epoch };
      turns.set(session, current);
    }
    // A new turn can bind only when there is no unresolved handoff. Old turns
    // cannot silently upgrade their epoch after a human intervenes.
    if (current.turn !== context.turnId) {
      if (session.agentHandoff) throw new Error('browser_paused');
      current = { turn: context.turnId, epoch: session.epoch };
      turns.set(session, current);
    }
    if (current.epoch !== session.epoch) throw new Error('browser_stale_control');
    return current.epoch;
  };
  const invoke = async (session, context, epoch, command) => {
    if (await owned(context) !== session || session.epoch !== epoch) throw new Error('browser_stale_control');
    const response = await send(session, null, epoch, command);
    if (await owned(context) !== session || session.epoch !== epoch) throw new Error('browser_stale_control');
    return response;
  };
  const rejected = error => ({ ok: false, outcome: 'rejected', error });
  const completed = data => ({ ok: true, outcome: 'completed', data });
  const chooseTarget = async (session, context, epoch, requested) => {
    const response = await invoke(session, context, epoch, { action: 'targets' });
    if (response.error || !Array.isArray(response.result)) throw new Error('browser_targets_unavailable');
    const targets = response.result;
    const target = requested ?? session.agentTarget ?? targets[0]?.target_id;
    if (!targets.some(item => item.target_id === target)) throw new Error('browser_target_unavailable');
    session.agentTarget = target;
    return { target, targets };
  };

  return {
    async available(context) {
      context.signal.throwIfAborted();
      if (!await authorize(context)) return false;
      context.signal.throwIfAborted();
      const session = sessions.get(context.threadId);
      return Boolean(session && !session.ended && session.owner === context.ownerUserId &&
        session.ready && session.control?.readyState === 1 && persistHandoff);
    },
    async execute(context, tool, args) {
      const session = await owned(context);
      const epoch = lease(session, context);
      if (session.agentHandoff) return rejected('browser_paused');
      if (tool === 'browser_close') {
        // Host admission proves that close is not racing private human control.
        const allowed = await invoke(session, context, epoch, { action: 'targets' });
        if (allowed.error) return rejected('browser_control_denied');
        end(session);
        return completed({ closed: true });
      }
      if (tool === 'browser_open' || tool === 'browser_observe' || args.action === 'navigate') {
        const { target, targets } = await chooseTarget(session, context, epoch, args.target_id);
        if (tool === 'browser_observe') {
          const response = await invoke(session, context, epoch, { action: 'observe', target });
          return response.error ? rejected('browser_command_rejected') : completed({ targets, observation: response.result });
        }
        if (args.url) {
          const response = await invoke(session, context, epoch, { action: 'navigate', target, url: args.url });
          if (response.error) return { ok: false, outcome: 'unknown', error: 'browser_outcome_unknown' };
        }
        // Navigation acknowledgement does not imply the document has loaded.
        return completed({ target_id: target, targets, navigation_requested: Boolean(args.url) });
      }
      const command = args.action === 'insert_text'
        ? { action: 'insert_text', text: args.text }
        : { action: args.action, reference: args.reference };
      const response = await invoke(session, context, epoch, command);
      // A generic host error may be after execution. Until typed host failures
      // exist, conservatively report unknown rather than promise a safe retry.
      return response.error ? { ok: false, outcome: 'unknown', error: 'browser_outcome_unknown' } : completed({ applied: true });
    },
    async park(context) {
      const session = await owned(context);
      const epoch = lease(session, context);
      if (!persistHandoff || session.agentHandoff) throw new Error('browser_handoff_unavailable');
      const response = await send(session, null, epoch, { action: 'pause' });
      if (response.error) throw new Error('browser_handoff_failed');
      if (await owned(context) !== session) throw new Error('browser_not_found');
      const handoff = { handoff_id: randomUUID(), viewer_path: `/api/browser-spike/threads/${encodeURIComponent(context.threadId)}/view` };
      // Set before persistence: failure must leave subsequent tools fenced.
      session.agentHandoff = { context, ...handoff };
      await persistHandoff({ ...context, ...handoff });
      return handoff;
    },
    // Called by the authenticated viewer route only after the host's successful
    // Return response, which contains the new observation. Durable continuation
    // remains the responsibility of the injected phase-0 composition.
    async returned(session, observation, persistReturn) {
      const pending = session.agentHandoff;
      if (!pending) return;
      if (!persistReturn) throw new Error('browser_resume_unavailable');
      const epoch = session.epoch;
      if (await owned(pending.context) !== session) throw new Error('browser_not_found');
      await persistReturn({ ...pending, observation });
      if (await owned(pending.context) !== session || session.epoch !== epoch) throw new Error('browser_stale_control');
      session.agentHandoff = undefined;
      turns.set(session, { turn: pending.context.turnId, epoch });
    },
  };
}
