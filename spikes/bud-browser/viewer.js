const $ = id => document.getElementById(id);
const socketURL = new URL(location.href.replace(/\/view$/, '/viewer'));
socketURL.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(socketURL);
socket.binaryType = 'arraybuffer';
let epoch = 1, controller = false, pending = null, lastHeartbeat = 0, stopped = false;
const setStatus = text => { $('status').textContent = text; };
const controls = enabled => {
  for (const id of ['return', 'observe', 'navigate', 'focus', 'click', 'insert']) $(id).disabled = !enabled;
};
socket.onmessage = async ({ data }) => {
  if (typeof data === 'string') {
    const result = JSON.parse(data);
    if (result.epoch) epoch = result.epoch;
    if ('ready' in result) { setStatus(result.ready ? 'Ready for takeover' : 'Waiting for host'); return; }
    const waiter = pending; pending = null;
    if (result.error) { waiter?.reject(new Error(result.error)); return; }
    waiter?.resolve(result.result);
  } else {
    const waiter = pending;
    try {
      const image = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (!stopped && controller) {
        const canvas = $('page');
        if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height; }
        canvas.getContext('2d').drawImage(image, 0, 0);
      }
      image.close();
      pending = null; waiter?.resolve(null);
    } catch (error) { pending = null; waiter?.reject(error); }
  }
};
const rpc = command => {
  if (pending || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Busy; try again'));
  return new Promise((resolve, reject) => { pending = { resolve, reject }; socket.send(JSON.stringify({ epoch, command })); });
};
const act = task => async () => { try { await task(); } catch (error) { setStatus(error.message); } };
const target = () => $('targets').value;
const observe = async () => {
  const result = await rpc({ action: 'observe', target: target() });
  $('elements').replaceChildren(...result.elements.map(element => {
    const option = document.createElement('option'); option.value = element.reference;
    option.textContent = `${element.role}: ${element.name}`; return option;
  }));
};
$('takeover').onclick = act(async () => {
  await rpc({ action: 'takeover' }); controller = true; lastHeartbeat = Date.now(); controls(true);
  const targets = await rpc({ action: 'targets' });
  $('targets').replaceChildren(...targets.map(item => {
    const option = document.createElement('option'); option.value = item.target_id; option.textContent = item.title || item.url; return option;
  }));
  setStatus('Private human control');
  await observe();
});
$('return').onclick = act(async () => {
  await rpc({ action: 'return', target: target() }); controller = false; controls(false);
  $('text').value = ''; $('elements').replaceChildren();
  $('page').getContext('2d').clearRect(0, 0, $('page').width, $('page').height);
  setStatus('Returned; fresh observation ready for agent');
});
$('observe').onclick = act(observe);
$('targets').onchange = act(observe);
$('navigate').onclick = act(async () => { await rpc({ action: 'navigate', target: target(), url: $('url').value }); await observe(); });
$('focus').onclick = act(async () => { await rpc({ action: 'focus', reference: $('elements').value }); $('text').focus(); });
$('click').onclick = act(async () => { await rpc({ action: 'click', reference: $('elements').value }); await observe(); });
$('insert').onclick = act(async () => {
  const text = $('text').value; $('text').value = '';
  await rpc({ action: 'insert_text', text }); setStatus('Text committed');
});
const timer = setInterval(async () => {
  if (!controller || pending || document.hidden || socket.readyState !== WebSocket.OPEN) return;
  try {
    if (Date.now() - lastHeartbeat >= 5000) { await rpc({ action: 'heartbeat' }); lastHeartbeat = Date.now(); }
    else if (target()) await rpc({ action: 'capture', target: target() });
  } catch { controller = false; controls(false); setStatus('Control unavailable; take control again'); }
}, 250);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    controller = false; controls(false); $('text').value = '';
    if (!pending) void rpc({ action: 'pause' }).catch(() => {});
    // In-flight input is not replayed. Host lease expiry remains the backstop.
    setStatus('Paused; take control again');
  }
});
socket.onclose = () => { stopped = true; controller = false; controls(false); clearInterval(timer); pending?.reject(new Error('Disconnected')); pending = null; $('text').value = ''; setStatus('Disconnected; reload to reconnect'); };
socket.onerror = () => socket.close();
