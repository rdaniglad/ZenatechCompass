// Optional: AI suggestions for the Discover page.
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function → name it "discover" → paste this file.
// Then add a secret ANTHROPIC_API_KEY (Edge Functions → Secrets) and set aiDiscover: true in web/config.js.
// Supabase checks the caller's sign-in automatically ("Verify JWT" on), so only signed-in Compass users can call it.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI discovery isn't set up. Add an ANTHROPIC_API_KEY secret to this function." }, 503);

  let prompt = "";
  try { prompt = String((await req.json()).prompt || "").slice(0, 4000); } catch { return json({ error: "Send JSON like {\"prompt\": \"...\"}." }, 400); }
  if (!prompt) return json({ error: "Missing prompt." }, 400);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6",
      max_tokens: 4000,
      system: "Return ONLY valid JSON matching what the user asks for — no prose, no markdown code fences.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) return json({ error: "AI request failed: " + (data?.error?.message || r.status) }, 502);
  const text = (data.content || []).map((b: { text?: string }) => b.text || "").join("").replace(/```json|```/g, "").trim();
  const start = text.search(/[\[{]/);
  try { return json(JSON.parse(start > 0 ? text.slice(start) : text)); }
  catch { return json({ error: "The AI reply wasn't valid JSON. Try again." }, 502); }
});
