/** Registry transitions, after the new carrier is routable. No heartbeat events. */
const listeners = new Set<(budId: string) => void>();
export function subscribePresence(listener: (budId: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyPresence(budId: string) {
  for (const listener of listeners) listener(budId);
}
