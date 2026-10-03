/**
 * compass-shim.js — connects the Compass app to Supabase.
 *
 * The app (index.html) talks to its backend only through
 *   await window.claude.use('db' | 'user' | 'assets' | 'downloads' | 'sample')
 * This file provides those calls on top of Supabase:
 *   db        → Postgres tables (events, roster, collateral_library, feedback, activity_log) + profiles
 *   user      → Supabase Auth session + the profiles table (names, roles, owner, turned off)
 *   assets    → Supabase Storage bucket "photos"
 *   live data → Supabase Realtime (onSnapshot)
 * Every read and write is checked by the rules in supabase/schema.sql, not just by the page.
 */
(function () {
  const cfg = window.COMPASS_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseKey && !/YOUR-PROJECT/i.test(cfg.supabaseUrl));

  function notConnected(msg) {
    const show = () => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg,#f5f7fb);color:var(--text,#161c2b);font:14px/1.5 Inter,system-ui,sans-serif;';
      d.innerHTML = '<div style="max-width:420px;background:var(--panel,#fff);border:1px solid var(--line,#d8dee8);border-radius:10px;padding:28px;"><div style="font-weight:700;font-size:17px;margin-bottom:8px;">Compass isn’t connected to Supabase yet</div><div id="nc-msg" style="color:var(--text-dim,#5a6478);font-size:13.5px;"></div></div>';
      document.body.appendChild(d);
      d.querySelector('#nc-msg').textContent = msg;
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
    window.claude = { use: async () => null };
  }
  if (!window.supabase || !window.supabase.createClient) return notConnected('The Supabase library didn’t load. Check your internet connection and reload.');
  if (!configured) return notConnected('Open web/config.js and fill in your Supabase Project URL and publishable key (Project Settings → API), then reload.');

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  window.compassSupabase = sb;

  const here = (file) => new URL(file, location.href).href;
  let leaving = false;
  function go(url) { leaving = true; location.replace(url); return new Promise(() => {}); }
  function toLogin(extra) {
    const next = location.pathname + location.search;
    return go(here('login.html') + '?' + (extra ? extra + '&' : '') + 'next=' + encodeURIComponent(next));
  }
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' && !leaving) go(here('login.html') + '?signedout=1'); });

  function fail(error) {
    let msg = (error && (error.message || error.error_description)) || String(error);
    if (/JWT expired|invalid JWT|not authenticated/i.test(msg)) { toLogin(); }
    if (/row-level security|permission denied/i.test(msg)) msg = 'You don’t have permission to make that change.';
    const e = new Error(msg); e.code = error && error.code; return e;
  }
  async function run(q) { const { data, error } = await q; if (error) throw fail(error); return data; }

  /* ---------------- who is signed in ---------------- */
  let _state = null, _me = null;
  function state() {
    if (!_state) {
      _state = (async () => {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return toLogin();
        const p = await run(sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
        if (!p) { leaving = true; await sb.auth.signOut(); return go(here('login.html') + '?noaccess=1'); }
        if (p.disabled) { leaving = true; await sb.auth.signOut(); return go(here('login.html') + '?disabled=1'); }
        _me = p;
        return { session, user: p };
      })();
    }
    return _state;
  }
  state();

  /* ---------------- photos ---------------- */
  window.compassBlobUrl = (id) => sb.storage.from('photos').getPublicUrl(id).data.publicUrl;

  /* ---------------- database ---------------- */
  const TABLE = { events: 'events', roster: 'roster', collateralLibrary: 'collateral_library', feedback: 'feedback', activityLog: 'activity_log' };
  const snap = (id, d) => ({ id, exists: !!d, data: () => d });
  const ms = (t) => (t ? new Date(t).getTime() : null);

  // "roles" and "members" in the app are both backed by the profiles table
  const PROFILE_VIEWS = {
    roles: { cols: 'id,role,name', toDoc: (p) => ({ role: p.role, name: p.name || '' }) },
    members: { cols: 'id,name,joined_at,last_seen', toDoc: (p) => ({ name: p.name || '', joinedAt: ms(p.joined_at), lastSeen: ms(p.last_seen) }) },
  };
  function profileCollection(name) {
    const v = PROFILE_VIEWS[name];
    const write = async (id, data) => {
      const patch = {};
      if (name === 'roles' && data.role) patch.role = data.role;
      if (name === 'members') { if (data.name) patch.name = data.name; patch.last_seen = new Date().toISOString(); }
      if (Object.keys(patch).length) await run(sb.from('profiles').update(patch).eq('id', id));
    };
    return {
      async get() { const rows = await run(sb.from('profiles').select(v.cols)); return { docs: rows.map((p) => snap(p.id, v.toDoc(p))) }; },
      doc(id) {
        return {
          async get() { const p = await run(sb.from('profiles').select(v.cols).eq('id', id).maybeSingle()); return snap(id, p ? v.toDoc(p) : null); },
          set: (data) => write(id, data || {}),
          update: (data) => write(id, data || {}),
          async delete() {},
        };
      },
      onSnapshot: (cb, onErr) => liveCollection('profiles', () => this_get(), cb, onErr),
    };
    function this_get() { return profileCollection(name).get(); }
  }
  function docCollection(name) {
    const table = TABLE[name];
    const api = {
      async get() {
        const rows = await run(sb.from(table).select('id,data').range(0, 4999));
        return { docs: rows.map((r) => snap(r.id, r.data || {})) };
      },
      doc(id) {
        return {
          async get() { const r = await run(sb.from(table).select('id,data').eq('id', id).maybeSingle()); return snap(id, r ? r.data || {} : null); },
          async set(data) {
            // create, or replace if it already exists
            const { error } = await sb.from(table).insert({ id, data: data || {} });
            if (!error) return;
            if (error.code !== '23505') throw fail(error);
            await run(sb.from(table).update({ data: data || {} }).eq('id', id));
          },
          // merge top-level fields atomically on the server (no lost updates)
          update: (patch) => run(sb.rpc('compass_merge', { p_table: table, p_id: id, p_patch: patch || {} })),
          delete: () => run(sb.from(table).delete().eq('id', id)),
        };
      },
      onSnapshot: (cb, onErr) => liveCollection(table, api.get, cb, onErr),
    };
    return api;
  }
  // Live updates: when anything in the table changes, re-read it (rules still apply) and report.
  function liveCollection(table, fetchAll, cb, onErr) {
    let t = null, stopped = false;
    const refresh = () => { clearTimeout(t); t = setTimeout(() => { fetchAll().then((s) => { if (!stopped) cb(s); }).catch((e) => onErr && onErr(e)); }, 300); };
    const channel = sb.channel('compass-' + table + '-' + Math.random().toString(36).slice(2, 8))
      .on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
      .subscribe((status) => { if (status === 'CHANNEL_ERROR' && onErr) onErr(new Error('Live updates unavailable for ' + table)); });
    fetchAll().then((s) => { if (!stopped) cb(s); }).catch((e) => onErr && onErr(e)); // first snapshot = current data
    return () => { stopped = true; sb.removeChannel(channel); };
  }
  function makeDb() {
    return { collection: (name) => (PROFILE_VIEWS[name] ? profileCollection(name) : TABLE[name] ? docCollection(name) : null) };
  }

  /* ---------------- user + accounts ---------------- */
  function makeUser() {
    return {
      async id() { return (await state()).user.id; },
      async me() { const u = (await state()).user; return { name: u.name || '', email: u.email }; },
      isOwner() { return !!(_me && _me.is_owner); },
      async profiles(ids) {
        if (!ids || !ids.length) return {};
        const rows = await run(sb.from('profiles').select('id,name,email').in('id', ids));
        const out = {}; rows.forEach((p) => { out[p.id] = { name: p.name || '', email: p.email }; }); return out;
      },
      // Activity email preference (account emails like password resets always send)
      async getEmailAlerts() { const { user } = await state(); const p = await run(sb.from('profiles').select('email_notifications').eq('id', user.id).single()); return p.email_notifications !== false; },
      async setEmailAlerts(on) { const { user } = await state(); await run(sb.from('profiles').update({ email_notifications: !!on }).eq('id', user.id)); return !!on; },
      async signOut() { leaving = true; await sb.auth.signOut(); go(here('login.html') + '?signedout=1'); },
      async changePassword(current, next) {
        const { user } = await state();
        const check = await sb.auth.signInWithPassword({ email: user.email, password: current });
        if (check.error) throw new Error('Your current password isn’t right.');
        const { error } = await sb.auth.updateUser({ password: next });
        if (error) throw fail(error);
        await sb.auth.signOut({ scope: 'others' }).catch(() => {});
      },
      accounts: {
        emailsInvites: true, // the database emails invites automatically (supabase/notifications.sql)
        async list() {
          const [profiles, invites] = await Promise.all([
            run(sb.from('profiles').select('*').order('joined_at')),
            run(sb.from('invites').select('*').gt('expires_at', new Date().toISOString()).order('created_at')),
          ]);
          const nameOf = {}; profiles.forEach((p) => { nameOf[p.id] = p.name || p.email; });
          return {
            users: profiles.map((p) => ({ id: p.id, name: p.name || '', email: p.email, role: p.role, isOwner: p.is_owner, disabled: p.disabled, createdAt: ms(p.joined_at), lastLoginAt: ms(p.last_seen) })),
            invites: invites.map((i) => ({ id: i.email, email: i.email, name: i.name || '', role: i.role, createdAt: ms(i.created_at), expiresAt: ms(i.expires_at), invitedBy: nameOf[i.invited_by] || '' })),
          };
        },
        async invite(email, name, role) {
          email = String(email || '').trim().toLowerCase();
          const existing = await run(sb.from('profiles').select('id').eq('email', email).maybeSingle());
          if (existing) throw new Error('Someone with that email already has an account.');
          const { user } = await state();
          const expires = new Date(Date.now() + 7 * 864e5).toISOString();
          await run(sb.from('invites').upsert({ email, name: name || null, role: role || 'attendee', invited_by: user.id, created_at: new Date().toISOString(), expires_at: expires }, { onConflict: 'email' }));
          return { email, role, expiresAt: ms(expires), link: here('login.html') + '?invite=' + encodeURIComponent(email) };
        },
        revokeInvite: (email) => run(sb.from('invites').delete().eq('email', email)),
        async resetLink(uid) {
          const p = await run(sb.from('profiles').select('email').eq('id', uid).single());
          const { error } = await sb.auth.resetPasswordForEmail(p.email, { redirectTo: here('login.html') });
          if (error) throw fail(error);
          return { emailed: true, email: p.email };
        },
        async setDisabled(uid, disabled) { await run(sb.from('profiles').update({ disabled: !!disabled }).eq('id', uid)); return { disabled: !!disabled }; },
      },
    };
  }

  /* ---------------- uploads ---------------- */
  function makeAssets() {
    return {
      async upload(file) {
        const ext = ((file.name || '').match(/\.[a-z0-9]{1,6}$/i) || [''])[0].toLowerCase();
        const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) + ext;
        await run(sb.storage.from('photos').upload(id, file, { contentType: file.type || undefined, upsert: false }));
        return { id, url: window.compassBlobUrl(id) };
      },
    };
  }

  /* ---------------- downloads (normal browser download) ---------------- */
  function makeDownloads() {
    return {
      async save({ filename, data }) {
        const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename || 'download';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return { ok: true };
      },
    };
  }

  /* ---------------- AI Discover (optional Edge Function) ---------------- */
  function makeSample() {
    if (!cfg.aiDiscover) return null;
    return {
      async json(prompt) {
        const { data, error } = await sb.functions.invoke('discover', { body: { prompt } });
        if (error) throw fail(error);
        if (data && data.error) throw new Error(data.error);
        return data;
      },
    };
  }

  window.claude = {
    use: async (name) => {
      if (name === 'db') { await state(); return makeDb(); }
      if (name === 'user') { await state(); return makeUser(); }
      if (name === 'assets') return makeAssets();
      if (name === 'downloads') return makeDownloads();
      if (name === 'sample') return makeSample();
      return null;
    },
  };
})();
