/**
 * compass-shim.js
 *
 * The Compass app (index.html, the big single-file app below this script) was originally
 * built as a Claude Artifact, so it talks to its backend entirely through
 * `await window.claude.use('db' | 'user' | 'assets' | 'downloads' | 'sample')`.
 *
 * This file defines that same `window.claude.use(...)` function, but backed by real
 * HTTP calls to this server's /api routes instead of Claude's runtime. It must load
 * BEFORE index.html's own <script> tag runs (it does — see the <script> order at the
 * bottom of index.html), so by the time the app calls window.claude.use(...), it's
 * already a real, working implementation.
 *
 * Nothing in the main app file needed to change for this to work — it has no idea
 * it's not running inside Claude anymore.
 */
(function () {
  const API = '/api';

  // The session lives in an HttpOnly cookie the browser sends automatically. Every request also
  // carries an x-compass header, which the server requires on writes (basic cross-site protection).
  function toLogin() {
    const next = location.pathname + location.search;
    location.replace('/login' + (next && next !== '/' ? '?next=' + encodeURIComponent(next) : ''));
  }
  async function request(url, opts) {
    opts = Object.assign({ credentials: 'same-origin' }, opts || {});
    opts.headers = Object.assign({}, opts.headers || {}, { 'x-compass': '1' });
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = 'Request failed (' + res.status + ')', body = null;
      try { body = await res.json(); if (body && body.error) msg = body.error; } catch (e) {}
      if (res.status === 401) { toLogin(); return new Promise(() => {}); } // signed out or session expired
      const err = new Error(msg); err.status = res.status; err.body = body;
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }
  const jsonHeaders = { 'Content-Type': 'application/json' };

  /* ---------------- db ---------------- */
  function makeDb() {
    return {
      collection(name) {
        return {
          async get() {
            const rows = await request(`${API}/collections/${name}`);
            return { docs: rows.map((r) => ({ id: r.id, exists: true, data: () => r })) };
          },
          doc(id) {
            return {
              async get() {
                try {
                  const r = await request(`${API}/collections/${name}/${id}`);
                  return { id, exists: true, data: () => r };
                } catch (e) {
                  return { id, exists: false, data: () => null };
                }
              },
              async set(data) {
                await request(`${API}/collections/${name}/${id}`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(data) });
              },
              async update(patch) {
                await request(`${API}/collections/${name}/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) });
              },
              async delete() {
                await request(`${API}/collections/${name}/${id}`, { method: 'DELETE' });
              },
            };
          },
        };
      },
    };
  }

  /* ---------------- user / identity ----------------
     Who's signed in comes from the server session (see /login and auth.js). If nobody is
     signed in, the page goes to the sign-in screen. */
  let _state = null, _me = null;
  function state() {
    if (!_state) {
      _state = request(`${API}/auth/state`).then((s) => {
        if (!s.user) { toLogin(); return new Promise(() => {}); }
        _me = s.user; return s;
      });
    }
    return _state;
  }
  state(); // start early
  function makeUser() {
    return {
      async id() { return (await state()).user.id; },
      async me() { const u = (await state()).user; return { name: u.name, email: u.email }; },
      isOwner() { return !!(_me && _me.isOwner); },
      async profiles(ids) {
        if (!ids || ids.length === 0) return {};
        return request(`${API}/profiles?ids=${encodeURIComponent(ids.join(','))}`);
      },
      // ---- account features (standalone server only; the Claude-hosted version doesn't have these) ----
      async signOut() {
        try { await request(`${API}/auth/logout`, { method: 'POST' }); } catch (e) {}
        location.replace('/login?signedout=1');
      },
      async changePassword(current, next) {
        await request(`${API}/auth/password`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ current, next }) });
      },
      accounts: {
        list: () => request(`${API}/accounts`),
        invite: (email, name, role) => request(`${API}/accounts/invites`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email, name, role }) }),
        revokeInvite: (id) => request(`${API}/accounts/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
        resetLink: (uid) => request(`${API}/accounts/users/${encodeURIComponent(uid)}/reset-link`, { method: 'POST', headers: jsonHeaders, body: '{}' }),
        setDisabled: (uid, disabled) => request(`${API}/accounts/users/${encodeURIComponent(uid)}/disabled`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ disabled }) }),
      },
    };
  }

  /* ---------------- assets (file uploads) ---------------- */
  function makeAssets() {
    return {
      async upload(file) {
        const fd = new FormData();
        fd.append('file', file);
        return request(`${API}/upload`, { method: 'POST', body: fd });
      },
    };
  }

  /* ---------------- downloads ----------------
     Outside Claude's sandbox there's no file-type allowlist to work around — this is a
     completely normal client-side Blob download. */
  function makeDownloads() {
    return {
      async save({ filename, data }) {
        const blob = new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename || 'download';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return { ok: true };
      },
    };
  }

  /* ---------------- sample (AI "Discover" suggestions) ---------------- */
  function makeSample() {
    return {
      async json(prompt, opts) {
        return request(`${API}/discover`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ prompt, opts }) });
      },
    };
  }

  window.claude = {
    use: async (name) => {
      if (name === 'db') return makeDb();
      if (name === 'user') return makeUser();
      if (name === 'assets') return makeAssets();
      if (name === 'downloads') return makeDownloads();
      if (name === 'sample') return makeSample();
      return null;
    },
  };
})();
