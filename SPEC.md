# Compass: Product Specification

**Product:** Compass, Zenatech's Global Events Command Center
**Owner:** Daniela (daniela@zenatech.com)
**Live at:** https://rdaniglad.github.io/ZenatechCompass/
**Code:** github.com/rdaniglad/ZenatechCompass
**Status:** in production (pilot)
**Last updated:** October 2026

---

## 1. Goal

Compass gives Zenatech one shared place to **decide which trade shows and conferences to attend, run them well, and learn whether they were worth it.**

Before Compass, the event pipeline lived in spreadsheets and email threads: more than 200 candidate shows across business units (DaaS, ZD, IQ Nano, ZT, SaaS), with no shared view of who was going, what it cost, what had been shipped, or what came out of it.

### What success looks like

| Outcome | How Compass supports it | Measure |
|---|---|---|
| Better event choices | Pipeline with priority, objective, audience size, cost and a composite impact score; AI Discover to find new shows | Share of attended events rated "worth attending again" in post-event reports |
| Nothing falls through the cracks | Readiness score, milestones, travel tracking, alerts, email reminders | Events reaching 100% readiness before the start date |
| Controlled spend | Cost per event, budget approval gate, rollups by business unit, quarter and year | Spend vs. budget; cost per lead |
| Learning loop | Post-event reports with photos, exported to Word | Reports submitted within 3 days of an event |
| Less coordination overhead | One source of truth, live updates, automatic notifications | Fewer status emails and meetings |

---

## 2. Users and roles

Compass is **invite-only**. Every person has exactly one role.

| Role | Who | Can do |
|---|---|---|
| **Admin** | Marketing and events leads | Everything, including inviting people, changing roles, turning accounts off, deleting events, approving budgets and editing the roster |
| **Manager** | Event planners, BU leads | Create and edit events, staff them, pack collateral, manage the collateral library, see everyone's reports |
| **Attendee** | Staff who travel to events | See their own conferences, join or leave event teams, update their own travel (hotel, flight, check-in), write their own post-event reports |

- **Owner:** the first account (daniela@zenatech.com). Always an Admin and can't be turned off.
- **Preview as / View as:** Admins can see Compass as another role or another person. This is read-only.

---

## 3. Functional specification

### 3.1 Sign-in and accounts
- **Sign-in:** email and password, with a minimum of 10 characters.
- **Invites:** an Admin enters an email and a role. The person is emailed an invite link, valid for 7 days, and the link can also be copied.
- **Account creation:** only invited emails can create an account, and the email address must be confirmed.
- **Forgotten password:** self-service reset by email. Admins can also send a reset email.
- **Account settings:** **Change password** (signs out other devices), **Sign out**, and an **Email alerts** on/off switch.
- **Turning accounts off:** an Admin can turn an account off, which immediately blocks all data access. Turning it back on restores access.

### 3.2 Dashboard ("Mission Control")
- **Key figures:** tracked events, events in the next 90 days, events at risk (under 70% ready and within 30 days), committed spend, people traveling, and average readiness.
- **World map:** every event as a pin colored by status, with a flat map or a rotating globe, real coastlines, and zoom and pan.
- **Lists:** "Up next" events and "Needs attention" events.
- **Alerts:** travel not booked within 14 days of an event, and people double-booked on overlapping events.

### 3.3 Events (pipeline)
- **Table:** filters by year, status, business unit and text search.
- **Statuses:** Investigating, Confirmed, Waitlist/Next Year, Completed, Will Not Attend Again.
- **Each event has seven tabs:**
  - **Overview:** status, business unit, location, website, audience and notes, plus links to Google Maps and calendar export (.ics).
  - **Cost & Impact:** booth, travel, lodging, shipping, miscellaneous and staff costs, optionally broken down per traveler. Also objective, priority, expected leads, cost per lead, and a 1–10 impact score.
  - **Team:** an attendee limit (default 6). People are assigned by drag-and-drop or tap, and can add or remove themselves.
  - **Collateral:** items are packed from the library, tracked by stock location and available quantity.
  - **Travel:** hotel booked, flight booked and check-in on arrival, per traveler.
  - **Progress:** a readiness % made up of cost entered (20), team assigned (25), required collateral packed (25), status confirmed (15) and website on file (15).
  - **Feedback:** post-event reports.
- **Budget approval:** an event can't move to Confirmed or Completed until an Admin approves its budget.

### 3.4 Project Map
- **Milestones** for Confirmed and Completed events: Paid, Staffed and Resourced (set manually), and Travel Planned, Checked In and Attended (set automatically from travelers' own updates).

### 3.5 My Conferences
- **Attendee home page:** the events I'm assigned to, my travel status, and quick buttons to update travel and write feedback.

### 3.6 Resource Map and Inventory
- **Resource Map:** a map of where people and assets are going, with lines from each traveler's home to the event.
- **Quick assignment:** drag a person or item onto an event, or tap it and then tap the event.
- **Inventory:** collateral availability across stock locations, with over-allocation blocked.

### 3.7 Team & Roster
- **People list:** name, title, email and home location.
- **Bulk import:** upload or paste a CSV, with preview, duplicate detection and validation.
- **Account linking:** each person's account links to their roster entry automatically.

### 3.8 Collateral Library
- **Items:** icon, description, a "required for every event" flag, and stock per location (quantity, or no limit).

### 3.9 Budget and Analytics
- **Budget:** spend rolled up by business unit, quarter and year, with CSV export.
- **Analytics:** total spend, expected leads, blended cost per lead, average impact score, a breakdown by business unit, and best and worst events by cost per lead.

### 3.10 Feedback (post-event reports)
- **Content:** place, purpose, summary, recommendation, follow-up actions, reference links and photos.
- **Visibility:** attendees see only their own reports; Admins and Managers see all of them.
- **Word export:** one click produces a .docx with a details table, sections, links and embedded photos.

### 3.11 Discover (AI event research)
- **Search:** live web search by industry, region and timeframe, using Claude with web search.
- **Results:** name, dates, venue, city and country, expected audience, why the event fits, official website and sources.
- **Duplicates:** results skip events already in the pipeline, and any that slip through are marked "Already in your pipeline".
- **Add to pipeline:** creates an Investigating event with the dates, location and website pre-filled.

### 3.12 Activity Log
- **Audit trail:** who did what and when, including created or deleted events, status changes, approvals, assignments, packing, roster and library changes, role changes, invites and account changes.
- **Retention:** the newest 1,000 entries are kept.

### 3.13 Email notifications

| Email | When |
|---|---|
| Confirm email / reset password / change email / sign-in link / confirmation code | Account actions (Supabase Auth, Compass-branded) |
| You're invited to Compass | An Admin invites someone |
| You're on the team / taken off the team | Team changes on an event |
| Event status changed | The status of an event you're on changes |
| Budget approved | An Admin approves an event you created |
| Book your hotel/flight | 7 days before a confirmed event, if travel isn't marked booked (daily at 9:00 Toronto time) |
| How was the event? | The day after an event you attended, if no report was submitted |
| Role changed / account turned off / back on | An Admin changes your access |

- **No self-notifications:** nobody is emailed about their own action.
- **Opting out:** people can switch activity emails off; account emails always arrive.
- **Retries:** failed sends are retried up to 5 times.

### 3.14 General
- **Live updates:** teammates' changes appear without reloading, and forms being edited aren't interrupted.
- **Safe concurrent edits:** two people editing the same event don't overwrite each other.
- **Layout and theme:** works on desktop, tablet and phone, with light and dark mode following the device setting.

---

## 4. Technical specification

### 4.1 Architecture

```
Browser (web/ — static HTML/JS, no build step)
   │  supabase-js
   ▼
Supabase project ZenatechProject (qjxdfqtzcrsopprcmicr)
   ├─ Auth            invite-only email/password, confirmation, resets
   ├─ Postgres        data + Row Level Security + triggers
   ├─ Storage         "photos" bucket
   ├─ Realtime        live updates
   ├─ pg_cron/pg_net  daily reminders, email hand-off
   └─ Edge Functions  send-notifications (email), discover (AI search)
          │                     │
          ▼                     ▼
   Resend / Gmail SMTP     Claude API (web search)
```

**Hosting:** GitHub Pages, deployed automatically on every push to `main` by `.github/workflows/pages.yml`.

### 4.2 Repository layout

| Path | Purpose |
|---|---|
| `web/` | The app: `index.html`, `login.html`, `compass-shim.js` (Supabase bridge) and `config.js` (project URL and publishable key) |
| `supabase/schema.sql` | Tables, security rules, triggers, storage and realtime |
| `supabase/notifications.sql` | Email queue, triggers, daily jobs and hand-off to the sender |
| `supabase/functions/send-notifications` | Sends activity emails through Resend or Gmail |
| `supabase/functions/discover` | AI event search with Claude and web search |
| `supabase/email-templates/` | Branded Supabase Auth emails |
| `supabase/tests/` | Database permission tests |
| `legacy/local-server/` | Earlier self-hosted Node.js version, kept for reference |

### 4.3 Data model
- **`profiles`:** id (auth user), email, name, role (admin, manager or attendee), is_owner, disabled, email_notifications, joined_at and last_seen.
- **`invites`:** email, name, role, invited_by and expires_at.
- **Document tables** (`id text`, `data jsonb`): `events`, `roster`, `collateral_library`, `feedback` and `activity_log`.
- **`notifications`:** the email outbox, holding kind, recipient, payload, status, attempts and error.
- **`compass_settings`:** site URL, function URL and the reminder window.

### 4.4 Security
- **Row Level Security** on every table: nothing is readable without signing in, and turned-off accounts see nothing.
- **Role checks in the database**, not only in the UI. For example, an attendee can only change their own team membership and travel on an event, enforced by the `guard_event` trigger, and only Admins can change roles (`guard_profile`).
- **Invite enforcement:** sign-up is refused unless the email was invited (`handle_new_user`).
- **Atomic partial updates** (`compass_merge`) prevent lost edits.
- **Secrets** (API keys, SMTP password, notification secret) live only in Supabase Edge Function secrets or Vault, never in the repo. The publishable key in `config.js` is public by design.
- **Tested:** 24 database permission tests and the notification trigger tests pass against the live project.

### 4.5 Integrations and configuration

| Integration | Setting | Where |
|---|---|---|
| Email (account emails) | SMTP: Gmail (temporary) or Resend `smtp.resend.com:465` | Supabase → Authentication → Emails → SMTP |
| Email (activity emails) | `RESEND_API_KEY` + `MAIL_FROM`, or `GMAIL_USER` + `GMAIL_APP_PASSWORD` | Edge Function secrets |
| Sending domain | zenatech.com DKIM/SPF records for Resend | Amazon Route 53 |
| AI search | `ANTHROPIC_API_KEY` | Edge Function secrets |
| Redirects | Site URL plus allowed redirect URLs | Supabase → Authentication → URL Configuration |

### 4.6 Non-functional requirements
- **Availability:** relies on the free tiers of GitHub Pages and Supabase. For production use, consider Supabase Pro (daily backups, no pausing).
- **Performance:** sized for about 50 users and thousands of events. Pages load the full dataset once and then update live.
- **Privacy:** only work data is stored (names, titles, work email, home city, travel status). Photos are stored under random, unguessable names.
- **Accessibility:** keyboard-usable controls, visible focus, labelled form fields, and alternatives to drag-and-drop.

---

## 5. Out of scope (current version)
- Booking travel or paying invoices inside Compass. It tracks status only.
- Lead capture or CRM sync. Expected leads are entered by hand.
- Single sign-on with Microsoft or Google, which can be added later in Supabase Auth.
- A native mobile app. The web app works on phones.

## 6. Open items

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | Add the Resend DNS records for zenatech.com in Route 53, then switch email to Resend (`daniela@zenatech.com`) | IT / Daniela | Pending |
| 2 | Save `ANTHROPIC_API_KEY` under that exact name so Discover works | Daniela | Pending |
| 3 | Delete the wrongly named secrets in the old project (kept as backup), then retire it | Daniela | Pending |
| 4 | Link people's new accounts to their existing roster entries (for example Phil) | Dev | Proposed |
| 5 | Decide whether the GitHub repo should be private (needs a paid plan for Pages) | Daniela | Open |
