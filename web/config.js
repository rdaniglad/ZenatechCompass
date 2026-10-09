/* Compass ↔ Supabase connection settings.
   Both values are designed to be public: they identify your project, and the database rules in
   supabase/schema.sql decide what each signed-in person can see and change.
   NEVER put the service_role / secret key here. */
window.COMPASS_CONFIG = {
  // Supabase Dashboard → Project Settings → API (or "Connect") → Project URL
  supabaseUrl: 'https://qjxdfqtzcrsopprcmicr.supabase.co',

  // Publishable key (sb_publishable_…) — or the legacy "anon public" key
  supabaseKey: 'sb_publishable_I3uxgMZ6ediDMwf9TNlF8w_6_7t6r4n',

};
