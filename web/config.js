/* Compass ↔ Supabase connection settings.
   Both values are designed to be public: they identify your project, and the database rules in
   supabase/schema.sql decide what each signed-in person can see and change.
   NEVER put the service_role / secret key here. */
window.COMPASS_CONFIG = {
  // Supabase Dashboard → Project Settings → API (or "Connect") → Project URL
  supabaseUrl: 'https://punsnbirawomuoeyaxty.supabase.co',

  // Publishable key (sb_publishable_…) — or the legacy "anon public" key
  supabaseKey: 'sb_publishable_oVdykmbWh5cS-gYMcU9gTg_1J9LbGqw',

  // Optional: AI suggestions on the Discover page. Needs the "discover" Edge Function
  // (supabase/functions/discover) deployed with an ANTHROPIC_API_KEY secret. See SETUP.md.
  aiDiscover: false,
};
