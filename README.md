# Compass: Global Events Command Center

Zenatech's planner for trade shows and conferences. Track the event pipeline on a world map, staff each show, pack booth collateral, follow travel bookings and check-ins, roll up budget and ROI, and collect post-event reports with photos. Reports export as Word files.

**Built on Supabase:** Postgres for data, Supabase Auth for invite-only accounts, Storage for photos, and Realtime for live updates. The app itself is plain HTML/JS with no build step.

**To set it up, follow [SETUP.md](SETUP.md).**

## Repository layout

```
web/                     ← the app. Deploy this folder (e.g. Vercel, Root Directory = web)
  index.html             Compass
  login.html             sign in · create account from invite · forgot / reset password
  compass-shim.js        connects the app to Supabase (data, accounts, photos, live updates)
  config.js              your Supabase Project URL + publishable key
supabase/
  schema.sql             run once in the SQL Editor: tables, security rules, storage, realtime
  functions/discover/    optional Edge Function for AI event suggestions
legacy/local-server/     the earlier self-hosted Node.js version (no Supabase), kept for reference
```

## Roles

- **Attendee:** sees their own conferences, updates their own travel, and writes their own reports.
- **Manager:** plans, staffs and packs events, and sees everyone's reports.
- **Admin:** everything above, plus inviting people, changing roles and turning accounts off.

The owner (the first account) is always an Admin.

All of these rules are enforced by the database (Row Level Security plus triggers in `supabase/schema.sql`), not only by the screens. See the table in SETUP.md.

## Local development

```
cd web
npx serve -l 8080        # or: python -m http.server 8080
```

Add `http://localhost:8080/login.html` to the Supabase **Redirect URLs**.
