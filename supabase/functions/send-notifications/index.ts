// Compass — sends queued activity emails (public.notifications) through Resend.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → name "send-notifications" → paste
// this file → turn OFF "Verify JWT" (the database calls it with its own secret instead).
// Secrets (Edge Functions → Secrets) — use ONE of the two senders:
//   Resend (recommended once zenatech.com is verified):
//     RESEND_API_KEY   your Resend API key
//     MAIL_FROM        e.g.  Compass <compass@zenatech.com>
//   Gmail (fine to start with; ~500 emails/day):
//     GMAIL_USER          the Gmail address, e.g. you@gmail.com
//     GMAIL_APP_PASSWORD  a Google App Password (myaccount.google.com/apppasswords), NOT your normal password
//     MAIL_FROM           optional, e.g.  Compass <you@gmail.com>
//   If both are set, Resend is used.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Row = { id: number; kind: string; to_email: string; to_name: string | null; payload: Record<string, any>; attempts: number };

Deno.serve(async (req) => {
  // Only the Compass database (which knows the shared secret) may trigger sending.
  const secret = req.headers.get("x-compass-secret") || "";
  const { data: ok } = await sb.rpc("compass_notify_secret_ok", { p_secret: secret });
  if (!ok) return json({ error: "not allowed" }, 401);

  const key = Deno.env.get("RESEND_API_KEY");
  const gmailUser = Deno.env.get("GMAIL_USER"), gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!key && !(gmailUser && gmailPass)) return json({ error: "No sender configured (RESEND_API_KEY or GMAIL_USER + GMAIL_APP_PASSWORD); emails stay queued." }, 503);
  const from = Deno.env.get("MAIL_FROM") || (key ? "Compass <onboarding@resend.dev>" : `Compass <${gmailUser}>`);
  // Gmail: one SMTP connection for the whole batch (port 465 / TLS — Supabase blocks 25 and 587)
  const smtp = key ? null : new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: gmailUser!, password: gmailPass!.replace(/\s+/g, "") } } });
  async function deliver(id: number, to: string, kind: string, m: Mail) {
    if (smtp) { await smtp.send({ from, to, subject: m.subject, content: m.text, html: m.html }); return; }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `compass-${id}` },
      body: JSON.stringify({ from, to: [to], subject: m.subject, html: m.html, text: m.text, tags: [{ name: "kind", value: kind }] }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }

  const { data: settings } = await sb.from("compass_settings").select("key,value");
  const site = (settings || []).find((s: any) => s.key === "site_url")?.value || "";

  // Claim a batch (pending, or failed with retries left)
  const { data: rows, error } = await sb.from("notifications").select("id,kind,to_email,to_name,payload,attempts")
    .in("status", ["pending", "failed"]).lt("attempts", 5).order("created_at").limit(40);
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ sent: 0 });
  await sb.from("notifications").update({ status: "sending" }).in("id", rows.map((r) => r.id));

  let sent = 0, failed = 0, skipped = 0;
  for (const row of rows as Row[]) {
    const mail = render(row, site);
    if (!mail) { skipped++; await sb.from("notifications").update({ status: "skipped", error: "unknown kind" }).eq("id", row.id); continue; }
    try {
      await deliver(row.id, row.to_email, row.kind, mail);
      sent++;
      await sb.from("notifications").update({ status: "sent", sent_at: new Date().toISOString(), attempts: row.attempts + 1, error: null }).eq("id", row.id);
    } catch (e) {
      failed++;
      await sb.from("notifications").update({ status: "failed", attempts: row.attempts + 1, error: String((e as Error).message || e).slice(0, 500) }).eq("id", row.id);
    }
    await new Promise((res) => setTimeout(res, 120)); // stay well under the provider's rate limit
  }
  if (smtp) await smtp.close().catch(() => {});
  return json({ sent, failed, skipped });
});

/* ======================================================================================
   Email content
   ====================================================================================== */
const ROLE: Record<string, string> = { admin: "Admin", manager: "Manager", attendee: "Attendee" };
const ROLE_WHAT: Record<string, string> = {
  admin: "full access, including inviting people and managing permissions",
  manager: "planning, staffing and packing events, and reading everyone's reports",
  attendee: "your own conferences, travel bookings and post-event reports",
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function fmtDate(d?: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return "";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function dates(p: Record<string, any>) {
  const a = fmtDate(p.start), b = fmtDate(p.end);
  return a && b && a !== b ? `${a} – ${b}` : a || "Dates to be confirmed";
}
const firstName = (n?: string | null) => (n || "").trim().split(/\s+/)[0] || "there";

type Mail = { subject: string; html: string; text: string };
function render(row: Row, site: string): Mail | null {
  const p = row.payload || {};
  // q = the same values HTML-escaped, for use inside sentences (names are typed by people)
  const q: Record<string, any> = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? esc(v) : v]));
  const hi = `Hi ${esc(firstName(row.to_name))},`;
  const open = { label: "Open Compass", url: site };
  const eventCard = p.eventName ? [["Event", p.eventName], ["When", dates(p)], ["Where", p.location || "Location to be confirmed"]] : [];

  switch (row.kind) {
    case "invite":
      return mail({
        preheader: `${p.invitedBy} invited you to Compass as ${ROLE[p.role] || "Attendee"}.`,
        subject: `${p.invitedBy} invited you to Compass`,
        heading: "You're invited to Compass",
        lines: [`Hi,`, `${q.invitedBy} invited you to join Zenatech's events workspace as ${article(ROLE[p.role] || "Attendee")} <b>${esc(ROLE[p.role] || "Attendee")}</b>, with access to ${ROLE_WHAT[p.role] || ROLE_WHAT.attendee}.`,
                `Create your account with this email address. The invite expires on ${fmtDate(String(p.expiresAt || "").slice(0, 10))}.`],
        button: { label: "Create your account", url: p.link },
        foot: "If you weren't expecting this invite, you can ignore this email.",
      });
    case "assigned":
      return mail({
        preheader: `You're on the team for ${p.eventName}, ${dates(p)}.`,
        subject: `You're on the team for ${p.eventName}`,
        heading: `You're going to ${p.eventName}`,
        lines: [hi, `${q.actor} added you to the team for this event.`],
        card: eventCard,
        after: ["Next steps: book your hotel and flight, then tick them off on the event's <b>Travel</b> tab so the team knows you're set."],
        button: open,
      });
    case "unassigned":
      return mail({
        preheader: `You're no longer on the team for ${p.eventName}.`,
        subject: `You've been taken off ${p.eventName}`,
        heading: `You're off the team for ${p.eventName}`,
        lines: [hi, `${q.actor} removed you from the team for this event. If you've already booked travel, check with them before cancelling anything.`],
        card: eventCard,
        button: open,
      });
    case "status":
      return mail({
        preheader: `${p.eventName} is now ${p.status}.`,
        subject: `${p.eventName} is now ${p.status}`,
        heading: `${p.eventName}: ${p.status}`,
        lines: [hi, `${q.actor} changed the status of an event you're on from <b>${q.oldStatus || "not set"}</b> to <b>${q.status}</b>.`],
        card: eventCard,
        button: open,
      });
    case "approved":
      return mail({
        preheader: `The budget for ${p.eventName} is approved.`,
        subject: `Budget approved: ${p.eventName}`,
        heading: "Budget approved",
        lines: [hi, `${q.actor} approved the budget for ${q.eventName}. It can now be marked Confirmed.`],
        card: eventCard,
        button: open,
      });
    case "travel_reminder": {
      const missing = [!p.hotelBooked && "hotel", !p.flightBooked && "flight"].filter(Boolean).join(" and ");
      const when = p.daysUntil === 0 ? "today" : p.daysUntil === 1 ? "tomorrow" : `in ${p.daysUntil} days`;
      return mail({
        preheader: `${p.eventName} starts ${when}. Your ${missing} isn't marked as booked.`,
        subject: `Reminder: book your ${missing} for ${p.eventName}`,
        heading: `${p.eventName} starts ${when}`,
        lines: [hi, `Your <b>${missing}</b> isn't marked as booked yet. If you've already booked it, tick it off on the event's <b>Travel</b> tab so the team can see you're set.`],
        card: eventCard,
        button: open,
      });
    }
    case "report_reminder":
      return mail({
        preheader: `Share how ${p.eventName} went while it's fresh.`,
        subject: `How was ${p.eventName}?`,
        heading: `How was ${p.eventName}?`,
        lines: [hi, "While it's fresh, please submit your post-event report: what happened, whether it's worth attending again, follow-up actions, and a few photos. It takes about five minutes."],
        card: eventCard,
        after: ["In Compass, open <b>My Conferences</b> and choose <b>+ Add feedback</b> on this event."],
        button: { label: "Write my report", url: site },
      });
    case "role_changed":
      return mail({
        preheader: `Your Compass role is now ${ROLE[p.role] || p.role}.`,
        subject: `Your Compass role is now ${ROLE[p.role] || p.role}`,
        heading: `You're now ${article(ROLE[p.role] || p.role)} ${ROLE[p.role] || p.role}`,
        lines: [hi, `${q.actor} changed your role from ${esc(ROLE[p.oldRole] || p.oldRole)} to <b>${esc(ROLE[p.role] || p.role)}</b>. You now have access to ${ROLE_WHAT[p.role] || "Compass"}.`],
        button: open,
      });
    case "account_disabled":
      return mail({
        preheader: "Your Compass account has been turned off.",
        subject: "Your Compass account has been turned off",
        heading: "Your account has been turned off",
        lines: [hi, `${q.actor} turned off your Compass account, so you can no longer sign in or see Compass data. Your past reports stay in Compass.`,
                "If you think this is a mistake, contact a Compass Admin."],
      });
    case "account_enabled":
      return mail({
        preheader: "Your Compass account is turned back on.",
        subject: "Your Compass account is back on",
        heading: "Welcome back",
        lines: [hi, `${q.actor} turned your Compass account back on. You can sign in again with your usual email and password.`],
        button: { label: "Sign in", url: site + "login.html" },
      });
  }
  return null;
}
function article(w: string) { return /^[aeiou]/i.test(w || "") ? "an" : "a"; }

/* ---------- one shared, email-client-safe layout (tables + inline styles) ---------- */
function mail(o: { preheader: string; subject: string; heading: string; lines: string[]; card?: string[][]; after?: string[];
                   button?: { label: string; url: string }; foot?: string }): Mail {
  const P = (h: string) => `<p style="margin:0 0 14px;font:15px/1.6 Segoe UI,Helvetica,Arial,sans-serif;color:#161c2b;">${h}</p>`;
  const card = o.card?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border:1px solid #d8dee8;border-radius:8px;background:#f5f7fb;">
        ${o.card.map(([k, v]) => `<tr><td style="padding:9px 14px;font:600 11px/1.4 Segoe UI,Helvetica,Arial,sans-serif;color:#8a93a6;text-transform:uppercase;letter-spacing:.06em;width:72px;vertical-align:top;">${esc(k)}</td><td style="padding:9px 14px 9px 0;font:15px/1.4 Segoe UI,Helvetica,Arial,sans-serif;color:#161c2b;">${esc(v)}</td></tr>`).join("")}
       </table>` : "";
  const button = o.button?.url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td style="border-radius:8px;background:#0e9488;">
         <a href="${esc(o.button.url)}" style="display:inline-block;padding:12px 22px;font:600 15px/1 Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:8px;">${esc(o.button.label)}</a>
       </td></tr></table>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(o.subject)}</title></head>
<body style="margin:0;padding:0;background:#eaeef5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eaeef5;"><tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
    <tr><td style="padding:0 4px 14px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:30px;height:30px;border-radius:8px;background:#0e9488;text-align:center;font:700 15px/30px Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">C</td>
        <td style="padding-left:10px;font:700 16px/1 Segoe UI,Helvetica,Arial,sans-serif;color:#161c2b;">Compass <span style="font-weight:400;color:#5a6478;font-size:13px;">· Zenatech events</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;border:1px solid #d8dee8;border-radius:12px;padding:28px 28px 12px;">
      <h1 style="margin:0 0 16px;font:700 22px/1.3 Segoe UI,Helvetica,Arial,sans-serif;color:#161c2b;">${esc(o.heading)}</h1>
      ${o.lines.map(P).join("")}${card}${(o.after || []).map(P).join("")}${button}
    </td></tr>
    <tr><td style="padding:16px 8px;font:12px/1.5 Segoe UI,Helvetica,Arial,sans-serif;color:#8a93a6;">
      ${o.foot ? esc(o.foot) + "<br>" : ""}You're receiving this because you use Compass, Zenatech's events workspace. To stop activity emails, open Compass and switch <b>Email alerts</b> off at the bottom of the menu.
    </td></tr>
  </table>
</td></tr></table></body></html>`;
  const strip = (h: string) => h.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [o.heading, "", ...o.lines.map(strip), ...(o.card || []).map(([k, v]) => `${k}: ${v}`), ...(o.after || []).map(strip),
                o.button?.url ? `${o.button.label}: ${o.button.url}` : "", "", o.foot || "", "— Compass · Zenatech events"].join("\n").replace(/\n{3,}/g, "\n\n");
  return { subject: o.subject, html, text };
}
