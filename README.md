# Compass — Global Events Command Center (standalone build)

This is the Claude-Artifact version of Compass packaged as a real, runnable application —
a small Node/Express server plus the original frontend, unmodified. No Claude account,
no claude.ai, nothing Anthropic-specific required to run it (the one optional exception is
noted below).

## Run it

**Windows:** double-click **`Start Compass.bat`**. It checks that Node.js is installed, creates `.env`, starts the server, and opens your browser.

**Any OS:**

```bash
npm start        # or: node server.js
```

Then open **http://localhost:3000**. There's nothing to `npm install`: the server uses only Node.js built-ins (Node 18+).
The first person to register becomes the Admin. The server tracks this (`_owner` in `data/db.json`), so opening the app in a new browser doesn't make someone else Admin.

## What's actually in here

```
server.js              Express server: serves the frontend + a small REST API
public/index.html       The original Compass app — completely unmodified business logic
public/compass-shim.js  Polyfills window.claude.use(...) with real fetch() calls to server.js
data/                    Created on first run — db.json (all your data) + uploads/ (photos)
```

**The important part:** `index.html` is the exact same frontend code that ran as a Claude
Artifact. It still calls `window.claude.use('db')`, `.use('user')`, etc. — we didn't touch
any of that, because rewriting ~3,000 lines of working UI/business logic would be wasted,
risky effort. Instead, `compass-shim.js` defines `window.claude` itself, backed by real
HTTP calls to `server.js`. The app has no idea it's not running inside Claude anymore.

## Storage

Everything lives in `data/db.json` — one JSON file, six collections (events, roster,
collateral library, roles, feedback, activity log). This is intentionally the simplest
possible thing that works, so you can run this today with zero infrastructure. It is
**not** meant to be your permanent production database — see "Growing past this" below.

Uploaded feedback photos land in `data/uploads/` and are served at `/_blob/<id>`.

## Signing in and accounts

Compass is **invite-only**. There's no public sign-up page.

**First run.** When the server starts with no accounts, it prints a one-time **setup code** in its
window. Open `http://localhost:3000`, go to the sign-in page, enter the code, and create the owner
account. The owner is always an Admin. Without the code, a stranger who reaches the server first
can't claim it.

**Inviting people (Admins).** Go to **Permissions → + Invite people**. Enter their email and pick
a role (Attendee, Manager or Admin). You get a one-time link that expires in 7 days. Compass doesn't
send emails, so paste the link into an email or chat yourself. When they open it, they choose their
name and a password and land in Compass with that role. Pending invites appear at the top of
Permissions, where you can create a **New link** or **Revoke** them.

**Forgotten passwords.** An Admin clicks **Reset password** next to the person on Permissions and
sends them the one-time link, which expires in 24 hours. Their old password keeps working until
they use it. Saving a new password signs them out on every other device.

**Changing your own password.** Use **Change password** at the bottom of the left menu. Other
devices are signed out and this one stays signed in.

**Turning an account off.** Click **Turn off** on Permissions. They're signed out immediately and
can't sign in until you click **Turn on**. Their events and reports stay. The owner account can't
be turned off.

**How it's protected** (see `auth.js`):

- Passwords need at least 10 characters. They're stored as scrypt hashes, never in plain text.
- Sessions use an HttpOnly, SameSite cookie and last 30 days on each device. Only a hash of the session id is saved, so a copied `db.json` can't be used to sign in.
- After 5 wrong passwords for an email, that email is locked for 15 minutes. One computer gets 30 wrong tries per 15 minutes.
- Invite and reset links work once, and only a hash of each link is stored.
- Every change request must carry a header that other websites can't add, which blocks cross-site request forgery.
- The app, the API and uploaded photos all require a signed-in session.
- What each role can change is still checked on the server for every write.

**Going live on a network.** Put Compass behind HTTPS (for example a reverse proxy) and set
`COOKIE_SECURE=1` and `PUBLIC_URL=https://compass.yourcompany.com` in `.env`, so cookies are
HTTPS-only and invite links use the right address.

**Upgrading from the earlier name-and-email build.** People who used it keep their roles and roster
links. When someone creates an account with the same email, Compass reuses their old id. The old
sign-in tokens stop working, so the owner runs the first-run setup once with their usual email and
then invites everyone else.

**Claude-hosted version.** It keeps using Claude accounts, so none of the above applies there.

## Backups

The server copies `data/db.json` to `data/backups/db-YYYY-MM-DD.json` once a day and keeps the
last 14 days. To restore one, stop the server, copy the backup over `data/db.json`, and start it again.

## The one optional AI feature

The Discover tab (AI-suggested trade shows) needs an Anthropic API key. Put it in `.env` as
`ANTHROPIC_API_KEY=...` to enable it. Leave it blank and that one tab shows a "not
configured" message — everything else in the app works fine either way.

## Growing past this

When you're ready to run this for real, in order of what to tackle first:

1. ~~Real auth~~ **Done.** Invite-only accounts with passwords, described above. If you later want Microsoft or Google single sign-on, add it in `auth.js`. The rest of the app only uses `who(req)`.
2. ~~Server-side permission checks~~ **Done.** See "Identity / login" above.
3. **A real database** — swap the JSON-file `loadDb()`/`saveDb()` in `server.js` for Postgres/MySQL/Mongo/whatever you run. Every route above those two functions stays the same; they only ever read/write `db[collection][id]`.
4. ~~Real map data~~ **Done.** Both maps now draw real Natural Earth 1:110m coastlines, embedded in the page so nothing is fetched at runtime. Street-level tiles (Leaflet/Mapbox) are still an option for the standalone server, but they can't load in the hosted Claude version.
5. ~~A real `.docx` for feedback reports~~ **Done.** The download button builds a real Word file (table, headings, links, photos) in the browser with no library. If that ever fails, it falls back to the old HTML report.
6. ~~Dark mode~~ **Done.** It follows the OS setting, or the Claude viewer's theme toggle in the hosted version.
