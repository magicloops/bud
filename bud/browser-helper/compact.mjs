// Compact serialization of the existing sanitized tree; never reads page values.
export const OBSERVATION_BYTES = 8 * 1024; // Leaves 4 KiB for the service tool envelope.
const states = ['disabled', 'checked', 'expanded', 'selected', 'level'];
const scopeRoles = new Set(['document', 'main', 'navigation', 'region', 'group', 'form', 'list', 'listitem', 'table', 'row', 'dialog']);
const passiveRoles = new Set(['text', 'generic', 'paragraph', 'rowgroup', 'cell', 'columnheader', 'rowheader', 'heading', 'img', 'image', 'separator']);

export function compactNodes(nodes) {
  const output = [], depths = [];
  for (const node of nodes) {
    while (depths.length && depths.at(-1).source >= node.depth) depths.pop();
    const hasState = states.some(key => node[key] !== undefined);
    // Keep genuine table/list structure and unnamed controls. Only generic,
    // paragraph and rowgroup wrappers without content/state are transparent.
    const transparent = ['generic', 'paragraph', 'rowgroup', 'none', 'presentation'].includes(node.role)
      && !node.name && !node.text && !hasState;
    if (transparent) continue;
    const depth = depths.length;
    const item = { ...node, depth };
    if (item.text === item.name) delete item.text;
    if (passiveRoles.has(node.role) && !scopeRoles.has(node.role)) delete item.reference;
    output.push(item);
    depths.push({ source: node.depth });
  }
  return output;
}

function line(node) {
  const state = states.filter(key => node[key] !== undefined).map(key => `${key}=${node[key]}`).join(' ');
  return `${'  '.repeat(Math.min(node.depth, 24))}${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${node.text ? `: ${JSON.stringify(node.text)}` : ''}${state ? ` [${state}]` : ''}${node.reference ? ` [ref=${node.reference}]` : ''}`;
}

export function compactPage(s, offset) {
  const ancestors = [];
  for (let i = 0; i < offset; i++) {
    while (ancestors.length && ancestors.at(-1).depth >= s.nodes[i].depth) ancestors.pop();
    ancestors.push(s.nodes[i]);
  }
  while (ancestors.length && ancestors.at(-1).depth >= (s.nodes[offset]?.depth ?? 0)) ancestors.pop();
  const render = end => {
    const nodes = s.nodes.slice(offset, end);
    return { format: 'compact_v1', target_id: s.target, document_id: s.document, observation_id: s.id,
      viewport: s.viewport,
      ...(s.mode === 'visible_dom' ? { nodes } : {
        text: [...(ancestors.length ? ['(continued within)', ...ancestors.map(line)] : []), ...nodes.map(line)].join('\n'),
      }),
      truncated: end < s.nodes.length, continuation: end < s.nodes.length ? `${s.id}:${end}` : null,
      expires_in_ms: Math.max(0, 60000 - (Date.now() - s.at)),
      coverage: s.mode === 'visible_dom' ? 'viewport' : s.scoped ? 'subtree' : 'document',
      limitations: ['Closed shadow roots and inaccessible embedded documents may be omitted.'] };
  };
  // Binary search the actual serialized envelope, including escaping and UTF-8.
  let low = offset, high = s.nodes.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(render(end))) <= OBSERVATION_BYTES) low = end;
    else high = end - 1;
  }
  if (low === offset && offset < s.nodes.length) throw new Error('browser_observation_limit');
  const result = render(low);
  if (Buffer.byteLength(JSON.stringify(result)) > OBSERVATION_BYTES) throw new Error('browser_observation_limit');
  return result;
}
