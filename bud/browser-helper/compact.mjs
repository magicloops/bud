// Compact serialization of the existing sanitized tree; never reads page values.
export const OBSERVATION_BYTES = 32 * 1024; // Leaves 4 KiB for the service tool envelope.
const states = ['disabled', 'checked', 'pressed', 'expanded', 'selected', 'level'];
const scopeRoles = new Set(['document', 'main', 'navigation', 'region', 'group', 'form', 'list', 'listitem', 'table', 'row', 'dialog']);
const passiveRoles = new Set(['text', 'generic', 'paragraph', 'rowgroup', 'cell', 'columnheader', 'rowheader', 'heading', 'img', 'image', 'separator']);

const empty = node => !node.name && !node.text && node.cursor !== 'pointer' && states.every(key => node[key] === undefined);

export function compactNodes(nodes) {
  const output = [], depths = [];
  for (const node of nodes) {
    while (depths.length && depths.at(-1).source >= node.depth) depths.pop();
    const hasState = states.some(key => node[key] !== undefined);
    // Keep genuine table/list structure and unnamed controls.
    const transparent = ['generic', 'paragraph', 'rowgroup', 'none', 'presentation'].includes(node.role)
      && !node.name && !node.text && !hasState && node.cursor !== 'pointer';
    if (transparent) continue;
    const depth = depths.length;
    const item = { ...node, depth };
    if (item.text === item.name) delete item.text;
    if (node.cursor !== 'pointer' && passiveRoles.has(node.role) && !scopeRoles.has(node.role)) delete item.reference;
    output.push(item);
    depths.push({ source: node.depth });
  }
  // Index direct children once. Only a sole-child table > row > cell > table
  // chain has no outer row/column relationship to preserve. Ambiguous tables,
  // blank data cells and named/stateful containers remain intact.
  const children = output.map(() => []), stack = [];
  for (let i = 0; i < output.length; i++) {
    while (stack.length && output[stack.at(-1)].depth >= output[i].depth) stack.pop();
    if (stack.length) children[stack.at(-1)].push(i);
    stack.push(i);
  }
  const removed = new Set();
  for (let i = 0; i < output.length; i++) {
    const node = output[i];
    if (node.role === 'row' && empty(node) && !children[i].length) removed.add(i);
    if (node.role !== 'table' || !empty(node)) continue;
    let at = i;
    const chain = [i];
    for (const role of ['row', 'cell', 'table']) {
      const child = children[at];
      if (child.length !== 1 || output[child[0]].role !== role) break;
      at = child[0];
      if (role === 'table') {
        for (const index of chain) removed.add(index);
      } else {
        if (!empty(output[at])) break;
        chain.push(at);
      }
    }
  }
  const result = [], retainedDepths = [];
  for (let i = 0; i < output.length; i++) {
    const node = output[i];
    while (retainedDepths.length && retainedDepths.at(-1) >= node.depth) retainedDepths.pop();
    if (removed.has(i)) continue;
    result.push({ ...node, depth: retainedDepths.length });
    retainedDepths.push(node.depth);
  }
  return result;
}

function line(node) {
  const state = states.filter(key => node[key] !== undefined).map(key => `${key}=${node[key]}`).join(' ');
  return `${' '.repeat(node.depth)}${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${node.text ? `: ${JSON.stringify(node.text)}` : ''}${state ? ` [${state}]` : ''}${node.reference ? ` [${node.reference}]` : ''}${node.cursor === 'pointer' ? ' [cursor=pointer]' : ''}${node.url !== undefined ? ` url=${JSON.stringify(node.url)}` : ''}`;
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
