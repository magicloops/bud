// Never return raw Playwright messages: they can include page text or input.
export function failureDiagnostic(error, stage) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return {
    stage: ['resolve_page', 'validate_snapshot', 'snapshot', 'resolve_element', 'validate_action', 'click', 'fill', 'focus'].indexOf(stage),
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
