// Select points before input. This is trusted helper code, never model supplied.
// Unsupported transforms fail closed; Playwright's final checks remain active.
function candidates(element, samples) {
  const parent = n => n.assignedSlot || n.parentElement || n.getRootNode()?.host;
  const deepHit = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    for (let i = 0; hit?.shadowRoot && i < 32; i++) {
      const next = hit.shadowRoot.elementFromPoint(x, y);
      if (!next || next === hit) break;
      hit = next;
    }
    return hit;
  };
  if (!element.isConnected) return { points: [], reason: 1 };
  const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  for (let n = element, depth = 0; n; n = parent(n), depth++) {
    const style = getComputedStyle(n);
    if (depth >= 128 || style.transform !== 'none' || Number(style.zoom || 1) !== 1 ||
        (style.rotate && style.rotate !== 'none') || (style.scale && style.scale !== 'none'))
      return { points: [], reason: 2 };
    if (n !== element) {
      const r = n.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, r.left + n.clientLeft);
        clip.right = Math.min(clip.right, r.left + n.clientLeft + n.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, r.top + n.clientTop);
        clip.bottom = Math.min(clip.bottom, r.top + n.clientTop + n.clientHeight);
      }
    }
  }
  const box = element.getBoundingClientRect(), style = getComputedStyle(element);
  const link = element.matches('a[href],[role="link"]');
  const safe = hit => {
    for (let n = hit, i = 0; n && i < 128; n = parent(n), i++) {
      if (n === element) return true;
      if (n.matches('a[href],button,input,select,textarea,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="menuitem"],[tabindex]')) return false;
      if (link && n.matches('img,video,audio,canvas,iframe,object,embed')) return false;
    }
    return false;
  };
  const points = [], seen = new Set();
  // Bound fragmented inline geometry as well as candidate count.
  const rects = Array.from(element.getClientRects()).slice(0, 8);
  for (let i = 0; i < samples.length; i++) {
    const r = rects[i % rects.length];
    if (!r) break;
    const left = Math.max(r.left, clip.left), right = Math.min(r.right, clip.right);
    const top = Math.max(r.top, clip.top), bottom = Math.min(r.bottom, clip.bottom);
    if (right <= left || bottom <= top) continue;
    const mx = Math.min(2, (right - left) / 4), my = Math.min(2, (bottom - top) / 4);
    const x = left + mx + samples[i].x * (right - left - 2 * mx);
    const y = top + my + samples[i].y * (bottom - top - 2 * my);
    const key = `${x.toFixed(2)},${y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!safe(deepHit(x, y))) continue;
    points.push({
      x, y,
      // Playwright expects padding-box-relative CSS coordinates.
      position: {
        x: x - box.left - (parseFloat(style.borderLeftWidth) || 0),
        y: y - box.top - (parseFloat(style.borderTopWidth) || 0),
      },
      normalized: { x: (x - box.left) / box.width, y: (y - box.top) / box.height },
    });
  }
  return { points, reason: points.length ? 0 : 3 };
}

// Check each ancestor frame without changing the chosen point or frame identity.
async function throughFrames(handle, points) {
  let frame = await handle.ownerFrame();
  let mapped = points.map((p, index) => ({ x: p.x, y: p.y, index }));
  for (let depth = 0; frame?.parentFrame() && mapped.length; depth++) {
    if (depth >= 32) return [];
    const element = await frame.frameElement();
    try {
      mapped = await element.evaluate((e, data) => {
        const parent = n => n.assignedSlot || n.parentElement || n.getRootNode()?.host;
        for (let n = e, depth = 0; n; n = parent(n), depth++) {
          const s = getComputedStyle(n);
          if (depth >= 128 || s.transform !== 'none' || Number(s.zoom || 1) !== 1 ||
              (s.rotate && s.rotate !== 'none') || (s.scale && s.scale !== 'none')) return [];
        }
        const r = e.getBoundingClientRect();
        return data.map(p => ({
          x: r.left + e.clientLeft + p.x, y: r.top + e.clientTop + p.y, index: p.index,
        })).filter(p => {
          let hit = document.elementFromPoint(p.x, p.y);
          for (let i = 0; hit?.shadowRoot && i < 32; i++) {
            const next = hit.shadowRoot.elementFromPoint(p.x, p.y);
            if (!next || next === hit) break;
            hit = next;
          }
          return hit === e;
        });
      }, mapped);
    } finally { await element.dispose(); }
    frame = frame.parentFrame();
  }
  const allowed = new Set(mapped.map(p => p.index));
  return points.filter((_, i) => allowed.has(i));
}

export async function selectClickPoint(handle, { random = Math.random, remaining, diagnostic = {} }) {
  // One preparation retry handles a pending wheel/layout update. Neither pass
  // clicks; both share the caller's deadline. Reason codes: detached=1,
  // unsupported geometry=2, no exposed candidate=3.
  for (let pass = 0; pass < 2; pass++) {
    await handle.scrollIntoViewIfNeeded({ timeout: remaining() });
    await handle.waitForElementState('stable', { timeout: remaining() });
    const samples = [];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++)
      samples.push({ x: (x + random()) / 5, y: (y + random()) / 5 });
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++)
      samples.push({ x: (x + .5) / 5, y: (y + .5) / 5 });
    const result = await handle.evaluate(candidates, samples);
    diagnostic.reason = result.reason;
    const valid = await throughFrames(handle, result.points);
    diagnostic.candidates = valid.length;
    if (valid.length) {
      const chosen = valid[Math.min(valid.length - 1, Math.floor(random() * valid.length))];
      diagnostic.x = chosen.normalized.x;
      diagnostic.y = chosen.normalized.y;
      return chosen.position;
    }
    diagnostic.reason ||= 3;
    if (result.reason === 1 || result.reason === 2) break;
  }
  throw Error('browser_click_blocked');
}
