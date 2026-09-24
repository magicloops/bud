// Compact serialization of the existing sanitized tree; never reads page values.
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
