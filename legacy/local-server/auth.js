/**
 * Compass accounts — invite-only sign-up, passwords, sessions, password resets.
 *
 * - Passwords are hashed with scrypt (Node built-in); the plain password is never stored.
 * - Sessions live in an HttpOnly cookie. Only a SHA-256 hash of each session id is saved in
 *   db.json, so a copied data file can't be used to sign in as anyone.
 * - Invite and reset links contain a one-time secret; only its hash is stored.
 * - First run: nobody can create the owner account without the setup code printed in the
 *   server console, so a stranger who reaches the server first can't claim it.
 */
const crypto = require('crypto');

const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;
const MIN_PASSWORD = 10;
const COOKIE = 'compass_sid';
const ROLES = ['attendee', 'manager', 'admin'];
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const now = () => Date.now();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const shortId = (p) => p + crypto.randomBytes(9).toString('hex');
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function checkPassword(pw, stored) {
  try {
    const [kind, salt, hash] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64, SCRYPT);
    return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex')); // keeps timing equal for unknown emails

const COMMON = ['password', '123456', 'qwerty', 'letmein', 'welcome', 'compass', 'zenatech', 'iloveyou', 'admin'];
function passwordProblem(pw, email) {
  pw = String(pw || '');
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'Use 200 characters or fewer.';
  const low = pw.toLowerCase();
  if (/^(.)\1+$/.test(pw)) return 'Avoid repeating a single character.';
  if (COMMON.some((w) => low.replace(/[^a-z0-9]/g, '').startsWith(w) && low.length < w.length + 6)) return 'That password is too easy to guess. Try a short phrase instead.';
  const local = normEmail(email).split('@')[0];
  if (local.length >= 4 && low.includes(local)) return 'Don’t include your email name in the password.';
  return null;
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) {
  return process.env.COOKIE_SECURE === '1' || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function sessionCookie(req, value, maxAgeSec) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}
function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return (isHttps(req) ? 'https' : 'http') + '://' + (req.headers.host || 'localhost');
}

module.exports = function createAuth({ getDb, saveDb, onFirstRun }) {
  const db = () => getDb();

  function init() {
    const d = db();
    if (!d._users) d._users = {};
    if (!d._invites) d._invites = {};
    if (!d._resets) d._resets = {};
    if (!d._sessions || typeof d._sessions !== 'object') d._sessions = {};
    // Drop sign-in tokens from the older name+email build — everyone signs in with a password now.
    Object.keys(d._sessions).forEach((k) => { if (typeof d._sessions[k] !== 'object') delete d._sessions[k]; });
    // Housekeeping: expired sessions / links
    const t = now();
    Object.keys(d._sessions).forEach((k) => { if (d._sessions[k].expiresAt < t) delete d._sessions[k]; });
    for (const coll of ['_invites', '_resets']) Object.keys(d[coll]).forEach((k) => { const x = d[coll][k]; if (x.usedAt || x.expiresAt < t - 30 * 864e5) delete d[coll][k]; });
    saveDb();
  }

  // First run: the owner account can only be created with this code (printed in the console)
  let setupCode = null;
  function setupNeeded() { return Object.keys(db()._users).length === 0; }
  function ensureSetupCode() {
    if (setupNeeded() && !setupCode) {
      setupCode = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');
      onFirstRun && onFirstRun(setupCode);
    }
    return setupCode;
  }

  /* ---------- rate limiting (failed sign-ins) ---------- */
  const fails = new Map(); // key -> {count, until}
  function limited(key) { const f = fails.get(key); return f && f.until > now() ? Math.ceil((f.until - now()) / 60000) : 0; }
  function fail(key, max, minutes) {
    const f = fails.get(key) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= max) { f.until = now() + minutes * 60000; f.count = 0; }
    fails.set(key, f);
  }
  const ipOf = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';

  /* ---------- users & sessions ---------- */
  function userByEmail(email) {
    const u = db()._users; email = normEmail(email);
    const id = Object.keys(u).find((k) => u[k].email === email);
    return id ? Object.assign({ id }, u[id]) : null;
  }
  function roleOf(uid) {
    const d = db();
    if (uid === d._owner) return 'admin';
    return (d.roles[uid] && d.roles[uid].role) || 'attendee';
  }
  function publicUser(uid) {
    const u = db()._users[uid];
    return u ? { id: uid, name: u.name, email: u.email, role: roleOf(uid), isOwner: uid === db()._owner } : null;
  }
  function createSession(req, uid) {
    const sid = secret();
    db()._sessions[sha256(sid)] = { uid, createdAt: now(), lastSeen: now(), expiresAt: now() + SESSION_DAYS * 864e5, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
    db()._users[uid].lastLoginAt = now();
    saveDb();
    return sessionCookie(req, sid, SESSION_DAYS * 86400);
  }
  function revokeSessions(uid, exceptHash) {
    const s = db()._sessions;
    Object.keys(s).forEach((k) => { if (s[k].uid === uid && k !== exceptHash) delete s[k]; });
  }
  /** Who is making this request? null if not signed in. */
  function who(req) {
    const sid = parseCookies(req)[COOKIE];
    if (!sid) return null;
    const h = sha256(sid);
    const s = db()._sessions[h];
    if (!s) return null;
    if (s.expiresAt < now()) { delete db()._sessions[h]; saveDb(); return null; }
    const u = db()._users[s.uid];
    if (!u || u.disabled) return null;
    if (now() - s.lastSeen > 3600e3) { s.lastSeen = now(); s.expiresAt = now() + SESSION_DAYS * 864e5; saveDb(); } // sliding 30 days
    return { uid: s.uid, role: roleOf(s.uid), sessionHash: h, user: u };
  }
  /** Reuse the id from the older name+email build when the email matches, so roles and roster links carry over. */
  function idForEmail(email) {
    const p = db()._profiles || {};
    const legacy = Object.keys(p).find((k) => normEmail(p[k].email) === email && !db()._users[k]);
    return legacy || shortId('u_');
  }
  function createUser(email, name, password) {
    const id = idForEmail(email);
    db()._users[id] = { email, name, pass: hashPassword(password), createdAt: now(), disabled: false };
    db()._profiles[id] = { name, email };
    return id;
  }
  function findByCode(coll, code) {
    if (!code || typeof code !== 'string') return null;
    const h = sha256(code), items = db()[coll];
    const id = Object.keys(items).find((k) => items[k].codeHash === h);
    if (!id) return null;
    const it = items[id];
    if (it.usedAt || it.expiresAt < now()) return { id, expired: true };
    return Object.assign({ id }, it);
  }

  /* ---------- HTTP handlers. Return true if the request was handled. ---------- */
  async function handle(req, res, p, m, { send, readJson }) {
    if (!p.startsWith('/api/auth/') && !p.startsWith('/api/accounts')) return false;
    const body = m === 'POST' || m === 'PATCH' ? await readJson(req) : {};
    const url = new URL(req.url, 'http://x');
    const me = who(req);
    const bad = (msg, status) => send(res, status || 400, { error: msg });

    // ----- public -----
    if (p === '/api/auth/state' && m === 'GET') {
      if (setupNeeded()) ensureSetupCode();
      return send(res, 200, { setupNeeded: setupNeeded(), user: me ? publicUser(me.uid) : null, minPassword: MIN_PASSWORD });
    }

    if (p === '/api/auth/setup' && m === 'POST') {
      if (!setupNeeded()) return bad('Compass is already set up. Sign in instead.', 409);
      const ip = ipOf(req), wait = limited('setup|' + ip);
      if (wait) return bad(`Too many attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`, 429);
      const code = String(body.setupCode || '').trim().toUpperCase().replace(/\s/g, '');
      if (!setupCode || code.replace('-', '') !== setupCode.replace('-', '')) { fail('setup|' + ip, 5, 15); return bad('That setup code doesn’t match. Copy it from the window where the Compass server is running.', 403); }
      const email = normEmail(body.email), name = cleanName(body.name);
      if (!name) return bad('Enter your name.');
      if (!validEmail(email)) return bad('Enter a valid email address.');
      const prob = passwordProblem(body.password, email);
      if (prob) return bad(prob);
      const uid = createUser(email, name, body.password);
      db()._owner = uid;
      setupCode = null;
      const cookie = createSession(req, uid);
      return send(res, 200, { ok: true, user: publicUser(uid) }, { 'Set-Cookie': cookie });
    }

    if (p === '/api/auth/login' && m === 'POST') {
      const email = normEmail(body.email), ip = ipOf(req);
      const wait = Math.max(limited('login|' + email), limited('ip|' + ip));
      if (wait) return bad(`Too many failed attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`, 429);
      const u = userByEmail(email);
      const ok = checkPassword(String(body.password || ''), u ? u.pass : DUMMY_HASH);
      if (!u || !ok) {
        fail('login|' + email, 5, 15); fail('ip|' + ip, 30, 15);
        return bad('That email and password don’t match. Check them and try again.', 401);
      }
      if (u.disabled) return bad('This account has been turned off. Ask a Compass Admin to turn it back on.', 403);
      fails.delete('login|' + email);
      const cookie = createSession(req, u.id);
      return send(res, 200, { ok: true, user: publicUser(u.id) }, { 'Set-Cookie': cookie });
    }

    if (p === '/api/auth/logout' && m === 'POST') {
      if (me) { delete db()._sessions[me.sessionHash]; saveDb(); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    if (p === '/api/auth/invite' && m === 'GET') {
      const inv = findByCode('_invites', url.searchParams.get('code'));
      if (!inv) return bad('This invite link isn’t valid. Check you copied the whole link, or ask for a new one.', 404);
      if (inv.expired) return bad('This invite link has expired or was already used. Ask a Compass Admin for a new one.', 410);
      if (userByEmail(inv.email)) return bad('An account for this email already exists. Sign in instead.', 409);
      const by = db()._users[inv.createdBy];
      return send(res, 200, { email: inv.email, name: inv.name || '', role: inv.role, invitedBy: by ? by.name : 'a Compass Admin' });
    }

    if (p === '/api/auth/accept' && m === 'POST') {
      const inv = findByCode('_invites', body.code);
      if (!inv) return bad('This invite link isn’t valid. Ask a Compass Admin for a new one.', 404);
      if (inv.expired) return bad('This invite link has expired or was already used. Ask a Compass Admin for a new one.', 410);
      if (userByEmail(inv.email)) return bad('An account for this email already exists. Sign in instead.', 409);
      const name = cleanName(body.name);
      if (!name) return bad('Enter your name.');
      const prob = passwordProblem(body.password, inv.email);
      if (prob) return bad(prob);
      const uid = createUser(inv.email, name, body.password);
      if (inv.role && inv.role !== 'attendee') db().roles[uid] = { role: inv.role, name, changedAt: now(), changedBy: inv.createdBy };
      db()._invites[inv.id].usedAt = now();
      db()._invites[inv.id].usedBy = uid;
      const cookie = createSession(req, uid);
      return send(res, 200, { ok: true, user: publicUser(uid) }, { 'Set-Cookie': cookie });
    }

    if (p === '/api/auth/reset' && m === 'GET') {
      const r = findByCode('_resets', url.searchParams.get('code'));
      if (!r) return bad('This reset link isn’t valid. Check you copied the whole link, or ask for a new one.', 404);
      if (r.expired) return bad('This reset link has expired or was already used. Ask a Compass Admin for a new one.', 410);
      const u = db()._users[r.uid];
      if (!u) return bad('This account no longer exists.', 404);
      return send(res, 200, { email: u.email, name: u.name });
    }

    if (p === '/api/auth/reset' && m === 'POST') {
      const r = findByCode('_resets', body.code);
      if (!r) return bad('This reset link isn’t valid. Ask a Compass Admin for a new one.', 404);
      if (r.expired) return bad('This reset link has expired or was already used. Ask a Compass Admin for a new one.', 410);
      const u = db()._users[r.uid];
      if (!u) return bad('This account no longer exists.', 404);
      if (u.disabled) return bad('This account has been turned off. Ask a Compass Admin to turn it back on.', 403);
      const prob = passwordProblem(body.password, u.email);
      if (prob) return bad(prob);
      u.pass = hashPassword(body.password);
      u.passwordChangedAt = now();
      db()._resets[r.id].usedAt = now();
      revokeSessions(r.uid);            // sign out every other device
      fails.delete('login|' + u.email);
      const cookie = createSession(req, r.uid);
      return send(res, 200, { ok: true, user: publicUser(r.uid) }, { 'Set-Cookie': cookie });
    }

    // ----- signed in -----
    if (!me) return bad('Please sign in again.', 401);

    if (p === '/api/auth/password' && m === 'POST') {
      if (!checkPassword(String(body.current || ''), me.user.pass)) return bad('Your current password isn’t right.', 403);
      const prob = passwordProblem(body.next, me.user.email);
      if (prob) return bad(prob);
      if (body.next === body.current) return bad('Choose a password you haven’t just used.');
      me.user.pass = hashPassword(body.next);
      me.user.passwordChangedAt = now();
      revokeSessions(me.uid, me.sessionHash); // other devices are signed out
      saveDb();
      return send(res, 200, { ok: true });
    }

    // ----- Admin: accounts -----
    if (me.role !== 'admin') return bad('Only Admins can manage accounts.', 403);
    const d = db();

    if (p === '/api/accounts' && m === 'GET') {
      const users = Object.keys(d._users).map((id) => {
        const u = d._users[id];
        return { id, name: u.name, email: u.email, role: roleOf(id), isOwner: id === d._owner, disabled: !!u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
      });
      const invites = Object.keys(d._invites).filter((k) => !d._invites[k].usedAt && d._invites[k].expiresAt > now()).map((k) => {
        const i = d._invites[k], by = d._users[i.createdBy];
        return { id: k, email: i.email, name: i.name || '', role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, invitedBy: by ? by.name : '' };
      });
      return send(res, 200, { users, invites });
    }

    if (p === '/api/accounts/invites' && m === 'POST') {
      const email = normEmail(body.email), role = ROLES.includes(body.role) ? body.role : 'attendee';
      if (!validEmail(email)) return bad('Enter a valid email address.');
      if (userByEmail(email)) return bad('Someone with that email already has an account.', 409);
      Object.keys(d._invites).forEach((k) => { if (d._invites[k].email === email && !d._invites[k].usedAt) delete d._invites[k]; }); // one live invite per email
      const code = secret(), id = shortId('inv_');
      d._invites[id] = { codeHash: sha256(code), email, name: cleanName(body.name), role, createdBy: me.uid, createdAt: now(), expiresAt: now() + INVITE_DAYS * 864e5 };
      saveDb();
      return send(res, 200, { id, email, role, expiresAt: d._invites[id].expiresAt, link: `${publicOrigin(req)}/login?invite=${code}` });
    }

    let mm = p.match(/^\/api\/accounts\/invites\/([^/]+)$/);
    if (mm && m === 'DELETE') {
      if (!d._invites[mm[1]]) return bad('That invite was already used or removed.', 404);
      delete d._invites[mm[1]]; saveDb();
      return send(res, 200, { ok: true });
    }

    mm = p.match(/^\/api\/accounts\/users\/([^/]+)\/reset-link$/);
    if (mm && m === 'POST') {
      const u = d._users[mm[1]];
      if (!u) return bad('That account doesn’t exist.', 404);
      Object.keys(d._resets).forEach((k) => { if (d._resets[k].uid === mm[1] && !d._resets[k].usedAt) delete d._resets[k]; }); // newest link wins
      const code = secret(), id = shortId('rst_');
      d._resets[id] = { codeHash: sha256(code), uid: mm[1], createdBy: me.uid, createdAt: now(), expiresAt: now() + RESET_HOURS * 3600e3 };
      saveDb();
      return send(res, 200, { email: u.email, expiresAt: d._resets[id].expiresAt, link: `${publicOrigin(req)}/login?reset=${code}` });
    }

    mm = p.match(/^\/api\/accounts\/users\/([^/]+)\/disabled$/);
    if (mm && m === 'POST') {
      const uid = mm[1], u = d._users[uid];
      if (!u) return bad('That account doesn’t exist.', 404);
      if (uid === d._owner) return bad('The owner account can’t be turned off.', 403);
      if (uid === me.uid) return bad('You can’t turn off your own account.', 403);
      u.disabled = !!body.disabled;
      if (u.disabled) revokeSessions(uid);
      saveDb();
      return send(res, 200, { ok: true, disabled: u.disabled });
    }

    return bad('not found', 404);
  }

  return { init, who, handle, ensureSetupCode, setupNeeded, publicUser };
};
