// Never return raw Playwright messages: they can include page text or input.
export function failureDiagnostic(error, stage, click = {}) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return {
    stage: ['resolve_page', 'validate_snapshot', 'snapshot', 'resolve_element', 'validate_action', 'click', 'fill', 'focus', 'prepare_click'].indexOf(stage),
    candidates: Number.isInteger(click.candidates) ? Math.max(0, Math.min(50, click.candidates)) : 0,
    point_reason: Number.isInteger(click.reason) && click.reason >= 0 && click.reason <= 3 ? click.reason : -1,
    point_x: Number.isFinite(click.x) ? Math.max(0, Math.min(1, click.x)) : null,
    point_y: Number.isFinite(click.y) ? Math.max(0, Math.min(1, click.y)) : null,
    preparation_ms: Number.isInteger(click.preparation_ms) ? Math.max(0, Math.min(3000, click.preparation_ms)) : null,
    timeout: error?.name === 'TimeoutError',
    intercepted: message.includes('intercepts pointer events'),
    invisible: message.includes('not visible'),
    unstable: message.includes('not stable'),
    disabled: message.includes('not enabled'),
    detached: message.includes('not attached') || message.includes('detached'),
    navigation_wait: message.includes('waiting for scheduled navigations'),
    target_closed: message.includes('Target page, context or browser has been closed'),
  };
}
