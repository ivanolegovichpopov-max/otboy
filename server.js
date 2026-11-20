// Сервер комнат «Отбой»: считает матч сам, игроки только подключаются.
// Игровая логика берётся прямо из index.html — один источник правды для клиента и сервера.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm');
const { WebSocketServer } = require('ws');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const gameScript = new vm.Script(scripts[scripts.length - 1][1], { filename: 'game.js' });

const TICK = 1 / 30, SNAP = 0.06, MAX_ROOMS = 30, MAX_HUMANS = 4;

// --- заглушки браузера: серверу нужна только логика, без картинки и звука
function makeGame() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const c2d = new Proxy({}, {
    get: (t, k) => k in t ? t[k]
      : k === 'createImageData' ? () => ({ data: new Uint8ClampedArray(16) })
      : k === 'createPattern' ? () => ({})
      : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => grad
      : k === 'measureText' ? () => ({ width: 10 }) : noop,
    set: (t, k, v) => { t[k] = v; return true; }
  });
  const el = () => ({ getContext: () => c2d, addEventListener: noop, setPointerCapture: noop, appendChild: noop, play: noop,
    classList: { add: noop, remove: noop, toggle: noop }, style: {}, width: 0, height: 0, value: '', textContent: '', innerHTML: '' });
  const els = {};
  const sb = {
    __SRV: true, console, performance, Math, Date, JSON,
    setTimeout: noop, setInterval: noop, clearInterval: noop, clearTimeout: noop, requestAnimationFrame: noop,
    Image: function () { this.complete = true; this.naturalWidth = 10; },
    matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem: noop },
    navigator: {}, location: { hash: '' }, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: noop,
    document: { getElementById: id => els[id] || (els[id] = el()), createElement: el, body: { appendChild: noop }, addEventListener: noop, hidden: false },
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  gameScript.runInContext(sb);
  return sb.API;
}

const VER = makeGame().ver;
const rooms = new Map();
const send = (ws, o) => { if (ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };
const cast = (room, o) => { const s = JSON.stringify(o); for (const c of room.clients) send(c, s); };
const live = room => room.running && !room.api.over();
const cleanName = (n, slot) => { n = typeof n === 'string' ? n.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) : ''; return n || 'Игрок ' + (slot + 1); };
const castRoom = room => { const pl = [...room.clients].map(c => ({ i: c.slot, name: c.name })).sort((a, b) => a.i - b.i);
  for (const c of room.clients) send(c, { t: 'room', code: room.code, n: pl.length, run: live(room) ? 1 : 0, pl, you: c.slot }); };

function newCode() { for (let i = 0; i < 200; i++) { const c = String(1000 + Math.floor(Math.random() * 9000)); if (!rooms.has(c)) return c; } return null; }
function freeSlot(room, want) {
  const used = new Set([...room.clients].map(c => c.slot));
  if (Number.isInteger(want) && want >= 0 && want < MAX_HUMANS && !used.has(want)) return want;
  for (let i = 0; i < MAX_HUMANS; i++) if (!used.has(i)) return i;
  return -1;
}
function leave(ws) {
  const room = ws.room; if (!room) return; ws.room = null;
  room.clients.delete(ws);
  if (room.running && ws.inGame) { try { room.api.release(ws.slot); } catch (e) {} }
  ws.inGame = false;
  if (room.clients.size) castRoom(room); else room.emptyAt = Date.now();
}
function startRoom(room) {
  const L = room.api.start([...room.clients].map(c => ({ i: c.slot, name: c.name })));
  for (const c of room.clients) c.inGame = true;
  room.running = true; room.last = performance.now(); room.acc = 0; room.overT = 0;
  for (const c of room.clients) send(c, { t: 'init', L, i: c.slot });
  castRoom(room);
}
function enter(ws, room) { ws.inGame = true; room.api.claim(ws.slot, ws.name); send(ws, { t: 'init', L: room.api.layout(), i: ws.slot }); }

function onMsg(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'join') {
    if (m.v !== VER) return send(ws, { t: 'err', m: 'Игра обновилась — обнови страницу и зайди снова' });
    leave(ws);
    let room;
    if (m.create) {
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', m: 'Сервер занят — попробуй чуть позже' });
      const code = newCode(); if (!code) return send(ws, { t: 'err', m: 'Не получилось создать комнату' });
      room = { code, api: makeGame(), clients: new Set(), running: false, last: 0, acc: 0, overT: 0, emptyAt: 0 };
      rooms.set(code, room);
    } else {
      room = rooms.get(String(m.code || ''));
      if (!room) return send(ws, { t: 'err', m: 'Комнаты с таким кодом нет. Проверь код или создай новую' });
    }
    const slot = freeSlot(room, m.slot);
    if (slot < 0) return send(ws, { t: 'err', m: 'В комнате уже 4 игрока' });
    ws.room = room; ws.slot = slot; ws.name = cleanName(m.name, slot); ws.inGame = false; room.clients.add(ws); room.emptyAt = 0;
    castRoom(room);
    if (m.re && live(room)) enter(ws, room);
    return;
  }
  const room = ws.room; if (!room) return;
  if (m.t === 'start') { if (!live(room)) startRoom(room); else enter(ws, room); }
  else if (m.t === 'leave') leave(ws);
  else if (m.t === 'name') { ws.name = cleanName(m.name, ws.slot); castRoom(room); }
  else if (!room.running || !ws.inGame) return;
  else if (m.t === 'i') room.api.input(ws.slot, m);
  else if (m.t === 'a') room.api.act(ws.slot, m);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end('otboy server ' + VER + ' · rooms ' + rooms.size);
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  ws.alive = true; ws.room = null; ws.slot = -1; ws.name = ''; ws.inGame = false;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } try { onMsg(ws, m); } catch (e) { console.error('msg', e); } });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// --- ход всех комнат
setInterval(() => {
  const now = performance.now();
  for (const room of rooms.values()) {
    if (!room.running) continue;
    const dt = Math.min(0.05, (now - room.last) / 1000); room.last = now;
    try {
      room.api.tick(dt); room.acc += dt;
      if (room.acc >= SNAP) { room.acc = 0; cast(room, room.api.snap()); }
      if (room.api.over()) { room.overT += dt; if (room.overT > 2) { room.running = false; for (const c of room.clients) c.inGame = false; castRoom(room); } }
    } catch (e) { console.error('tick', room.code, e); room.running = false; cast(room, { t: 'err', m: 'Ошибка на сервере — начните матч заново' }); }
  }
}, TICK * 1000);

// --- уборка: мёртвые соединения и пустые комнаты
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
  const now = Date.now();
  for (const [code, room] of rooms) if (!room.clients.size && room.emptyAt && now - room.emptyAt > 120000) rooms.delete(code);
}, 20000);

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log('otboy server', VER, 'on', PORT));
