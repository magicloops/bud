// Workspace facade. Authority and ownership are always checked by the daemon.
export function createBrowser(operation) {
  const images = new WeakMap();
  const observations = new Map();
  const inspect = async (id, operationName, options = {}) => (await operation({ ...options, action: 'inspect', target_id: id, operation: operationName })).observation;
  function tab(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw Error('browser_invalid_target');
    const evaluate = (frame_id, fn, argument = null) => {
      if (typeof fn !== 'function') throw Error('browser_evaluate_requires_function');
      return operation({ action: 'repl', operation: 'evaluate', target_id: id, frame_id,
        source: fn.toString(), argument: JSON.parse(JSON.stringify(argument)) });
    };
    const observe = async (kind, options) => {
      const result = await operation({ ...options, action: 'repl', operation: kind, target_id: id });
      observations.set(id, result.observation_id);
      return result;
    };
    const evidence = () => {
      const observation_id = observations.get(id);
      if (!observation_id) throw Error('browser_observation_required');
      return observation_id;
    };
    const element = options => {
      // Bind evidence now, not when the retained handle is eventually invoked.
      const observation_id = evidence();
      return Object.freeze({
        click: () => inspect(id, 'click', { ...options, observation_id }),
        fill: text => inspect(id, 'fill', { ...options, observation_id, text }),
        focus: () => inspect(id, 'focus', { ...options, observation_id }),
      });
    };
    return Object.freeze({ id,
      async info() { return inspect(id, 'page_info'); },
      async title() { return (await this.info()).title; },
      async url() { return (await this.info()).url; },
      async goto(url) { return operation({ action: 'navigate', target_id: id, url }); },
      snapshot(options = {}) { return observe('snapshot', options); },
      visibleDom(options = {}) { return observe('visible_dom', options); },
      getByReference(reference) { return element({ reference }); },
      getByRole(role, { name, exact = true, scope } = {}) {
        if (exact !== true || typeof name !== 'string') throw Error('browser_exact_name_required');
        return element({ locator: { role, name }, ...(scope === undefined ? {} : { scope }) });
      },
      scroll(delta_y) { return inspect(id, 'scroll', { observation_id: evidence(), delta_y }); },
      insertText(text) { return operation({ action: 'repl', operation: 'insert_text', target_id: id, text }); },
      select() { return operation({ action: 'repl', operation: 'select_tab', target_id: id }); },
      async close() {
        const result = await operation({ action: 'repl', operation: 'close_tab', target_id: id });
        observations.delete(id); return result;
      },
      evaluate(fn, argument) { return evaluate(null, fn, argument); },
      frames() { return operation({ action: 'repl', operation: 'frames', target_id: id }); },
      frame(frame_id) { return Object.freeze({ evaluate: (fn, argument) => evaluate(frame_id, fn, argument) }); },
      async screenshot() {
        const frame = await operation({ action: 'repl', operation: 'screenshot', target_id: id });
        const bytes = Buffer.from(frame.image, 'base64'); images.set(bytes, frame); return bytes;
      },
    });
  }
  return { browser: Object.freeze({
    // Internal bridge retained for foundation fixtures; not a raw CDP endpoint.
    operation,
    tabs: Object.freeze({
      async list() { return operation({ action: 'repl', operation: 'tabs' }); },
      async current() { const pages = await this.list(); return pages.length ? tab(pages.find(p => p.selected)?.target_id ?? pages[0].target_id) : null; },
      get: tab,
      async open(url) { const result = await operation({ action: 'open', ...(url === undefined ? {} : { url }) }); return tab(result.target_id); },
      async create(url) { const result = await operation({ action: 'repl', operation: 'create_tab', ...(url === undefined ? {} : { url }) }); return tab(result.target_id); },
    }),
  }), async emitImage(bytes, index) {
    const frame = images.get(bytes);
    if (!frame) throw Error('browser_image_requires_screenshot');
    return operation({ action: 'repl', operation: 'emit_image', target_id: frame.target_id, frame, index });
  } };
}
