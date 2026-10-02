/**
 * Compass — standalone server (zero dependencies)
 * Uses only Node.js built-ins (Node 18+), so there is nothing to `npm install`.
 * Serves the frontend and the small REST API that public/compass-shim.js calls.
 *
 * Storage: data/db.json (one JSON file) + data/uploads/ (photos).
 * Accounts / sign-in: see auth.js (invite-only, passwords, cookie sessions).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createAuth = require('./auth');

/* ---------------- .env loader (replaces dotenv) ---------------- */
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_BODY = 16 * 1024 * 1024;
const COLLECTIONS = ['events', 'roster', 'collateralLibrary', 'roles', 'feedback', 'activityLog', 'members'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- storage ---------------- */
function loadDb() {
  let raw = {};
  if (fs.existsSync(DB_FILE)) {
    try { raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) {
      const bak = DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(DB_FILE, bak);
      console.error('db.json was unreadable; backed up to ' + bak + ' and starting fresh.');
    }
  }
  COLLECTIONS.forEach((c) => { if (!raw[c]) raw[c] = {}; });
  if (!raw._profiles) raw._profiles = {};
  if (raw._owner === undefined) raw._owner = null;
  if (!raw._sessions) raw._sessions = {}; // sign-in token -> user id
  return raw;
}
let db = loadDb();
let saveTimer = null;
function writeNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE); // atomic replace so a crash can't half-write the file
}
function saveDb() { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 150); }
writeNow();

const auth = createAuth({
  getDb: () => db,
  saveDb,
  onFirstRun: (code) => {
    console.log('\n  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │  First run: create the owner account                     │');
    console.log(`  │  Open http://localhost:${String(PORT).padEnd(5)}/login and enter setup code ${code} │`);
    console.log('  └──────────────────────────────────────────────────────────┘\n');
  },
});
auth.init();

/* Daily backups: data/backups/db-YYYY-MM-DD.json, keeping the last 14 days */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function backupNow() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, 'db-' + day + '.json');
    if (!fs.existsSync(target)) fs.copyFileSync(DB_FILE, target);
    fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -14)
      .forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) { console.error('backup failed:', e.message); }
}
backupNow();
setInterval(backupNow, 6 * 60 * 60 * 1000).unref();

/* ---------------- helpers ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};
function send(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) && file !== root) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}
const safeId = (s) => /^[A-Za-z0-9_.\-:@+~]{1,200}$/.test(s || '');

/* ---------------- who is asking, and what their role allows ----------------
   Identity comes from the signed-in session cookie (auth.js). The role comes from the server's own
   data, never from the browser, and the owner (who set Compass up) is always an Admin. */
function who(req) { return auth.who(req); }
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
function myRosterId(uid) { return Object.keys(db.roster).find((k) => db.roster[k].userId === uid) || null; }
/* Attendees may only add/remove themselves from an event's team and update their own travel entry */
function attendeeEventPatchOk(me, cur, patch) {
  const pid = myRosterId(me.uid);
  if (!pid) return false;
  for (const k of Object.keys(patch)) {
    if (k === 'attendees') {
      const before = new Set(cur.attendees || []), after = new Set(patch.attendees || []);
      const changed = [...before].filter((x) => !after.has(x)).concat([...after].filter((x) => !before.has(x)));
      if (changed.some((x) => x !== pid)) return false;
      if (after.has(pid) && !before.has(pid) && after.size > (cur.maxAttendees || 6)) return false;
    } else if (k === 'travel') {
      const a = cur.travel || {}, b = patch.travel || {};
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) if (key !== pid && !same(a[key], b[key])) return false;
    } else return false;
  }
  return true;
}
/* Returns null when allowed, or a plain-language reason when not */
function writeDenied(me, name, id, method, body) {
  const isMgr = me.role === 'admin' || me.role === 'manager';
  const cur = db[name][id];
  const next = method === 'PATCH' ? Object.assign({}, cur || {}, body) : body;
  switch (name) {
    case 'roles':
      return me.role === 'admin' ? null : 'Only Admins can change roles.';
    case 'members':
      return id === me.uid ? null : 'You can only update your own profile.';
    case 'collateralLibrary':
      return isMgr ? null : 'Only Admins and Managers can change the collateral library.';
    case 'roster':
      if (me.role === 'admin') return null;
      if (method === 'DELETE') return 'Only Admins can remove people from the roster.';
      if (next && next.userId === me.uid && (!cur || cur.userId === me.uid)) return null; // your own roster link
      return 'Only Admins can edit the roster.';
    case 'events':
      if (method === 'DELETE') return me.role === 'admin' ? null : 'Only Admins can delete events.';
      if (isMgr) return null;
      if (method !== 'PATCH' || !cur) return 'Only Admins and Managers can create or replace events.';
      return attendeeEventPatchOk(me, cur, body || {}) ? null : 'You can only add or remove yourself and update your own travel.';
    case 'feedback':
      if (isMgr) return null;
      if (method === 'DELETE') return cur && cur.authorId === me.uid ? null : 'You can only delete your own reports.';
      return (!cur || cur.authorId === me.uid) && next && next.authorId === me.uid ? null : 'You can only edit your own reports.';
    case 'activityLog':
      if (method === 'DELETE') return me.role === 'admin' ? null : 'Only Admins can clear the activity log.';
      return method === 'PUT' && !cur && body && body.actorId === me.uid ? null : 'Activity entries can\'t be edited.';
  }
  return 'Not allowed.';
}
function canRead(me, name, row) {
  if (name === 'feedback' && me.role === 'attendee') return row.authorId === me.uid; // attendees only see their own reports
  return true;
}
function trimActivity() {
  const ids = Object.keys(db.activityLog);
  if (ids.length <= 1000) return;
  ids.sort((a, b) => (db.activityLog[a].ts || 0) - (db.activityLog[b].ts || 0)).slice(0, ids.length - 1000)
    .forEach((k) => delete db.activityLog[k]);
}

/* ---------------- AI Discover (optional) ---------------- */
async function discover(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('AI discovery is not configured. Set ANTHROPIC_API_KEY in .env to enable it.'), { status: 503 });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: 'Return ONLY valid JSON matching what the user asks for — no prose, no markdown code fences.',
      messages: [{ role: 'user', content: prompt || '' }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error('AI request failed: ' + ((data.error && data.error.message) || r.status)), { status: 502 });
  const text = (data.content || []).map((b) => b.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.search(/[\[{]/);
  return JSON.parse(start > 0 ? clean.slice(start) : clean);
}

/* ---------------- router ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const m = req.method;

  // Basic CSRF protection: every state-changing API call must carry a header that other sites can't send
  if (p.startsWith('/api/') && m !== 'GET' && m !== 'HEAD' && req.headers['x-compass'] !== '1') {
    return send(res, 403, { error: 'Request blocked. Reload Compass and try again.' });
  }

  // sign-in, invites, password resets, account admin
  if (await auth.handle(req, res, p, m, { send, readJson })) return;

  // collections
  let mm = p.match(/^\/api\/collections\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (mm) {
    const [, name, id] = mm;
    if (!COLLECTIONS.includes(name)) return send(res, 404, { error: 'unknown collection: ' + name });
    const me = who(req);
    if (!me) return send(res, 401, { error: 'Please sign in again.' });
    const col = db[name];
    if (!id) {
      if (m !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, Object.keys(col).filter((k) => canRead(me, name, col[k])).map((k) => Object.assign({ id: k }, col[k])));
    }
    if (!safeId(id)) return send(res, 400, { error: 'invalid id' });
    if (m === 'GET') return col[id] && canRead(me, name, col[id]) ? send(res, 200, Object.assign({ id }, col[id])) : send(res, 404, { error: 'not found' });
    if (!['PUT', 'PATCH', 'DELETE'].includes(m)) return send(res, 405, { error: 'method not allowed' });
    const body = m === 'DELETE' ? null : await readJson(req);
    if (body !== null && (typeof body !== 'object' || Array.isArray(body))) return send(res, 400, { error: 'expected a JSON object' });
    const denied = writeDenied(me, name, id, m, body);
    if (denied) return send(res, 403, { error: denied });
    if (m === 'PUT') col[id] = body;
    else if (m === 'PATCH') col[id] = Object.assign({}, col[id] || {}, body);
    else delete col[id];
    if (name === 'activityLog') trimActivity();
    saveDb();
    return send(res, 200, { ok: true });
  }

  // names for user ids (used to show who did what)
  if (p === '/api/profiles' && m === 'GET') {
    if (!who(req)) return send(res, 401, { error: 'Please sign in again.' });
    const out = {};
    String(url.searchParams.get('ids') || '').split(',').filter(Boolean).forEach((id) => {
      const u = db._users[id] || db._profiles[id];
      if (u) out[id] = { name: u.name, email: u.email };
    });
    return send(res, 200, out);
  }

  // uploads (multipart/form-data, field "file") — parsed with Node's built-in Request
  if (p === '/api/upload' && m === 'POST') {
    if (!who(req)) return send(res, 401, { error: 'Please sign in again.' });
    const buf = await readBody(req);
    let file;
    try {
      const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: buf }).formData();
      file = fd.get('file');
    } catch (e) { return send(res, 400, { error: 'could not read upload' }); }
    if (!file || typeof file === 'string') return send(res, 400, { error: 'no file received' });
    const ext = (path.extname(file.name || '').toLowerCase().match(/^\.[a-z0-9]{1,6}$/) || [''])[0];
    const id = Date.now().toString(36) + crypto.randomBytes(5).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, id), Buffer.from(await file.arrayBuffer()));
    return send(res, 200, { id, url: '/_blob/' + id });
  }

  if (p === '/api/discover' && m === 'POST') {
    if (!who(req)) return send(res, 401, { error: 'Please sign in again.' });
    const body = await readJson(req);
    return send(res, 200, await discover(body.prompt));
  }

  if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  if (m !== 'GET' && m !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  if (p.startsWith('/_blob/')) {
    if (!who(req)) { res.writeHead(401); return res.end(); }
    return serveFile(res, UPLOAD_DIR, p.slice('/_blob/'.length));
  }
  if (p === '/login' || p === '/login.html') return serveFile(res, PUBLIC_DIR, 'login.html');
  if (p === '/' || p === '/index.html') {
    // The app itself is only served to signed-in people
    if (!who(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return serveFile(res, PUBLIC_DIR, 'index.html');
  }
  return serveFile(res, PUBLIC_DIR, p.slice(1));
}

const server = http.createServer((req, res) => {
  // Security headers on every response. no-referrer keeps invite/reset links out of other sites' logs.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'server error' });
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Close the other program or set PORT=3001 in .env.\n`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`\n  Compass is running → http://localhost:${PORT}`);
  console.log(`  Data is saved in ${DATA_DIR}`);
  console.log(`  AI Discover: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'off (add ANTHROPIC_API_KEY to .env to enable)'}`);
  console.log('  Press Ctrl+C to stop.\n');
  if (auth.setupNeeded()) auth.ensureSetupCode();
});
function shutdown() { clearTimeout(saveTimer); try { writeNow(); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
