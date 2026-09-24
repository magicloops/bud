// Pure presentation of a retained, sanitized observation. No page access or
// global alias registry: action handles close over this observation's identity.
const bytes = text => Buffer.byteLength(text);
const quoted = value => JSON.stringify(value);
const states = ['disabled', 'checked', 'pressed', 'expanded', 'selected', 'level', 'cursor'];
export function snapshotView(source, element, remainingBytes = () => 8192) {
  const indices = new Map(source.nodes.map((node, i) => [node, i]));
  const counts = new Map();
  for (const node of source.nodes) if (typeof node.url === 'string')
    counts.set(node.url, (counts.get(node.url) ?? 0) + 1);
  const urls = new Map();
  for (const [url, count] of counts) if ((count > 1 && bytes(url) > 32) || bytes(url) > 256)
    urls.set(url, `u${urls.size + 1}`);
  const byUrl = new Map([...urls].map(([url, key]) => [key, url]));
  // Cache only data from the plain bridge result, not later agent modifications.
  const records = source.nodes.map((node, i) => {
    const ref = node.reference;
    const alias = urls.get(node.url);
    const depth = Number.isInteger(node.depth) ? node.depth : 0;
    const text = `${' '.repeat(Math.min(depth, 40))}d${depth} ${node.role}` +
      (ref ? ` [e${i + 1}]` : '') +
      (node.name !== undefined ? ` name=${quoted(node.name)}` : '') +
      (node.text !== undefined ? ` text=${quoted(node.text)}` : '') +
      states.filter(key => node[key] !== undefined).map(key => ` ${key}=${quoted(node[key])}`).join('') +
      (node.url !== undefined ? ` url=${alias ?? quoted(node.url)}` : '');
    return {ref, alias, text};
  });
  const identity = {target_id: source.target_id, document_id: source.document_id,
    observation_id: source.observation_id, coverage: source.coverage,
    limitations: source.limitations, source_truncated: source.truncated};
  return Object.defineProperties(source, {
    getByReference: {value: ref => {
      const match = typeof ref === 'string' && /^e([1-9]\d*)$/.exec(ref);
      const record = match && records[Number(match[1]) - 1];
      if (!record?.ref) throw Error('browser_invalid_reference');
      return element(record.ref, identity.observation_id);
    }},
    url: {value: key => {
      if (!byUrl.has(key)) throw Error('browser_invalid_url_reference');
      return byUrl.get(key);
    }},
    format: {value: ({nodes = source.nodes, maxBytes = 32768} = {}) => {
      if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > 32768 || !Array.isArray(nodes))
        throw Error('browser_invalid_arguments');
      // A view cannot expand the cell output budget. Reserve console's newline
      // and keep records intact even when a caller requests a larger view.
      maxBytes = Math.min(maxBytes, Math.max(0, remainingBytes() - 1));
      const selected = nodes.map(node => {
        if (!indices.has(node)) throw Error('browser_snapshot_node_required');
        return indices.get(node);
      });
      // Keep source order even for user-selected subsets; duplicates add no evidence.
      const ordered = [...new Set(selected)].sort((a, b) => a - b);
      const header = `Snapshot ${quoted(identity)}\nRefs belong to this snapshot; use snapshot.getByReference("eN"). URL aliases resolve with snapshot.url("uN").\n`;
      const footer = included => `\n[Snapshot view: ${included}/${ordered.length} selected nodes shown; ${records.length} captured nodes. ${included < ordered.length ? 'PREVIEW: remaining selected nodes omitted; select from retained nodes or increase maxBytes/output budget.' : 'Selection is not proof of complete page coverage.'}]`;
      if (bytes(header + footer(0)) > maxBytes)
        return '[Snapshot metadata exceeds view budget; inspect retained coverage/limitations and select nodes explicitly.]';
      let text = header, included = 0;
      const defined = new Set();
      for (const index of ordered) {
        const record = records[index];
        let definition = '';
        if (record.alias && !defined.has(record.alias)) {
          const exact = `${record.alias}=${quoted(byUrl.get(record.alias))}\n`;
          definition = bytes(exact) <= Math.floor(maxBytes / 4) ? exact
            : `${record.alias}=[long exact URL retained; use snapshot.url(${quoted(record.alias)})]\n`;
        }
        const block = definition + record.text + '\n';
        if (bytes(text + block + footer(included + 1)) > maxBytes) break;
        text += block; included++;
        if (record.alias) defined.add(record.alias);
      }
      return text + footer(included);
    }},
  });
}
