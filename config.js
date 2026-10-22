/* =====================================================================
   IdeaVault — frontend configuration
   =====================================================================
   This file contains PUBLIC configuration only. It is safe to commit
   and publish on GitHub Pages.

   The Supabase URL and anon (publishable) key are *designed* to be
   public: every table in supabase/schema.sql is protected by Postgres
   Row Level Security, so anonymous visitors who know these values can
   read nothing and change nothing. Only signed-in team members can.

   NEVER place the following in this file (or anywhere in the frontend):
     - the Supabase service_role key
     - Instagram / Meta access tokens
     - the INSTAGRAM_APP_SECRET or INSTAGRAM_VERIFY_TOKEN
   Those live in Supabase Edge Function secrets — see README.md.
   ===================================================================== */

window.IDEAVAULT_CONFIG = {
  /* Supabase → Project Settings → API → "Project URL"
     Example: 'https://abcdefghij.supabase.co'
     Leave blank to run the app in demo mode with sample data.        */
  supabaseUrl: 'https://lqnckkrtitvfycpqnvmu.supabase.co',

  /* Supabase → Project Settings → API → Project API keys →
     the key tagged "anon" / "publishable" (NOT service_role).        */
  supabaseAnonKey: 'sb_publishable_aZL6c-w2FiCDdl-Gfv9MJw_CY54BU2k',

  /* The dedicated Instagram account that collects Reel shares. */
  instagramHandle: 'IdeaVault-IG',
  instagramUrl: 'https://www.instagram.com/ideavault-ig',

  /* Fallback refresh interval (seconds) when Supabase realtime is not
     available. 0 disables polling. Realtime updates are used when they
     work, so new Reels usually appear without waiting.               */
  pollSeconds: 60
};
