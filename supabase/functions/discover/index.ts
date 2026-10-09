// Compass — "Discover events": finds real, upcoming trade shows with a LIVE web search (Claude + web search tool).
//
// Deploy: Supabase → Edge Functions → Deploy a new function → name "discover" → paste this file →
// turn OFF "Verify JWT with legacy secret" (this function checks the signed-in Compass user itself).
// Secret (Edge Functions → Secrets):  ANTHROPIC_API_KEY  — from console.anthropic.com (usage is billed by Anthropic)
// Optional secret: ANTHROPIC_MODEL (default below).

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  // Only signed-in, active Compass users
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return json({ error: "Please sign in to Compass again." }, 401);
  const { data: prof } = await admin.from("profiles").select("disabled").eq("id", auth.user.id).maybeSingle();
  if (!prof || prof.disabled) return json({ error: "Your Compass account can't use this." }, 403);

  // The key is normally saved as ANTHROPIC_API_KEY; also accept it under any other secret name (Claude keys start with "sk-ant-")
  const key = Deno.env.get("ANTHROPIC_API_KEY") || Object.values(Deno.env.toObject()).find((v) => typeof v === "string" && v.trim().startsWith("sk-ant-"))?.trim();
  if (!key) return json({ error: "AI search isn't set up yet. An Admin needs to add the ANTHROPIC_API_KEY secret in Supabase." }, 503);

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const industry = String(body.industry || "").slice(0, 200) || "general B2B";
  const region = String(body.region || "").slice(0, 200) || "anywhere";
  const timeframe = String(body.timeframe || "").slice(0, 200) || "the next 12 months";
  const known = Array.isArray(body.known) ? (body.known as unknown[]).slice(0, 300).map(String).join("; ") : "";
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Today is ${today}. You help Zenatech's events team find trade shows, conferences and summits worth exhibiting at or attending.
Brief — industry/keyword: ${industry}. Region: ${region}. Timeframe: ${timeframe}.
Use web search to find up to 8 REAL upcoming events that match, with their official dates, city/venue and official website. Only include events whose next edition falls inside the timeframe. Prefer official event websites as sources.
${known ? `The team already tracks these events; do not suggest them again: ${known}` : ""}
When you are done researching, reply with ONLY a JSON array (no prose, no markdown fences). Each item:
{"name": string, "startDate": "YYYY-MM-DD" or "", "endDate": "YYYY-MM-DD" or "", "city": string, "country": string, "venue": string, "website": string (official URL), "audience": number or null (expected attendees, only if stated), "why": string (one sentence on why it fits the brief)}`;

  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  const messages: unknown[] = [{ role: "user", content: prompt }];
  let data: any = null;
  for (let turn = 0; turn < 4; turn++) {               // server-side tool runs can pause; continue up to 3 times
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 6000, messages, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }] }),
    });
    data = await r.json();
    if (!r.ok) return json({ error: "AI search failed: " + (data?.error?.message || r.status) }, 502);
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }

  const blocks = (data?.content || []) as any[];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  const sources = [...new Set(blocks.flatMap((b) => (b.citations || []).map((c: any) => c.url)).filter(Boolean))];
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("["), end = clean.lastIndexOf("]");
  try {
    const events = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean);
    return json({ events: Array.isArray(events) ? events : [], sources, searchedAt: new Date().toISOString() });
  } catch {
    return json({ error: "The AI reply couldn't be read. Try again or change the search terms." }, 502);
  }
});
