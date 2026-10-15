const el = id => document.getElementById(id);
let search = '', cursor, contact, historyCursor, coordinate, generation = 0, controller;
const name = row => [row.fields?.given_name, row.fields?.family_name].filter(Boolean).join(' ') || row.fields?.organization || 'Unnamed contact';
const date = value => value ? new Date(value).toLocaleString() : 'Unknown';
async function query(path, parameters = {}) {
  const response = await fetch(`/api/${path}?${new URLSearchParams(parameters)}`, { signal: controller.signal });
  if (!response.ok) throw new Error(response.status === 403 ? 'App access was revoked or does not include this data.' : 'Data is unavailable. Try again.');
  return response.json();
}
function begin() { controller?.abort(); controller = new AbortController(); el('status').textContent = 'Loading…'; return ++generation; }
function failed(error, version) { if (version === generation && error.name !== 'AbortError') el('status').textContent = error.message; }
async function list(more = false) {
  const version = begin();
  if (!more) { cursor = undefined; el('results').replaceChildren(); el('detail').hidden = true; el('map-container').replaceChildren(); }
  el('more').hidden = true;
  try {
    const result = await query('contacts', { search, ...(cursor ? { cursor } : {}) });
    if (version !== generation) return;
    for (const row of result.data.items) {
      const button = document.createElement('button'); button.textContent = name(row);
      button.onclick = () => select(row); el('results').append(button);
    }
    cursor = result.data.next_cursor; el('more').hidden = !cursor;
    el('status').textContent = result.data.items.length ? '' : 'No contacts on this page.';
  } catch (error) { failed(error, version); }
}
async function history(version, more = false) {
  if (!more) { historyCursor = undefined; el('history').replaceChildren(); }
  el('more-history').hidden = true;
  const result = await query(`contacts/${contact.id}/history`, historyCursor ? { cursor: historyCursor } : {});
  if (version !== generation) return;
  for (const row of result.data.items) {
    const paragraph = document.createElement('p');
    paragraph.textContent = `${name(row)} · ${date(row.observed_at)} · ${row.visible ? 'Visible to source' : 'No longer visible to source'}`;
    el('history').append(paragraph);
  }
  historyCursor = result.data.next_cursor; el('more-history').hidden = !historyCursor;
}
async function select(row) {
  const version = begin(); contact = row; coordinate = undefined;
  el('detail').hidden = false; el('name').textContent = name(row);
  el('observed').textContent = `First observed ${date(row.first_observed_at)}. Source identities are independent across devices.`;
  el('map').hidden = true; el('map-container').replaceChildren(); el('location').textContent = 'Loading evidence…';
  try { await history(version); } catch (error) { failed(error, version); }
  if (version !== generation) return;
  try {
    const center = Date.parse(row.first_observed_at);
    const result = await query(`contacts/${row.id}/location-context`, { from: new Date(center - 86400000).toISOString(), to: new Date(center + 86400000).toISOString() });
    if (version !== generation) return;
    const evidence = result.data.evidence; coordinate = evidence?.coordinate;
    el('location').textContent = evidence ? `${result.data.uncertainty} Observed ${date(evidence.occurred_at)}, received ${date(evidence.received_at)}. Accuracy ±${evidence.source_horizontal_accuracy_m} m; precision ${evidence.coordinate_precision}.` : 'No location evidence in this window.';
    el('map').hidden = !coordinate; el('status').textContent = '';
  } catch (error) { if (version === generation) el('location').textContent = error.message; }
}
el('search').onsubmit = event => { event.preventDefault(); search = el('term').value; void list(); };
el('more').onclick = () => list(true);
el('more-history').onclick = async () => { const version = begin(); try { await history(version, true); if (version === generation) el('status').textContent = ''; } catch (error) { failed(error, version); } };
el('map').onclick = () => {
  if (!coordinate) return;
  const { lat, lon } = coordinate;
  const frame = document.createElement('iframe'); frame.title = 'Location observation map'; frame.referrerPolicy = 'no-referrer';
  const parameters = new URLSearchParams({ bbox: `${lon-.01},${lat-.01},${lon+.01},${lat+.01}`, marker: `${lat},${lon}`, layer: 'mapnik' });
  frame.src = `https://www.openstreetmap.org/export/embed.html?${parameters}`;
  el('map-container').replaceChildren(frame); el('map').hidden = true;
};
async function health() {
  const now = Date.now(), day = 86400000, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const line = (target, text) => { const paragraph = document.createElement('p'); paragraph.textContent = text; el(target).append(paragraph); };
  const load = async (path, parameters, target, render) => {
    try {
      const response = await fetch(`/api/${path}?${new URLSearchParams(parameters)}`);
      if (!response.ok) return line(target, response.status === 403 ? 'Not shared with this app.' : 'Unavailable. Try again later.');
      const items = (await response.json()).data.items;
      if (!items.length) line(target, 'No records in this period.');
      for (const item of items) line(target, render(item));
    } catch { line(target, 'Unavailable. Try again later.'); }
  };
  const hours = minutes => `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  await Promise.all([
    load('health/sleep', { from: new Date(now - 14 * day).toISOString(), to: new Date(now).toISOString(), timezone }, 'sleep',
      night => `Night of ${night.night_of}: ${hours(night.asleep_minutes)} asleep (${night.source.name})`),
    load('health/workouts', { from: new Date(now - 30 * day).toISOString(), to: new Date(now).toISOString() }, 'workouts',
      workout => `${date(workout.start_at)} · ${workout.activity_type.replaceAll('_', ' ')} · ${Math.round(workout.duration_s / 60)} min`),
  ]);
}
void list();
void health();
