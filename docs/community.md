# Community plan hub

The community hub lets players share factory plans, browse and preview what
others built, vote, and open any shared plan directly in the editor.

## Architecture

- **Frontend**: the Library and Share menu inside the planner. Legacy `/community`
  links redirect to the planner and carry the plan ID when one is present.
- **API**: Next.js routes under `src/app/api/community/**`. All validation,
  stat derivation, vote deduplication, and rate limiting happen here.
- **Storage**: Supabase Postgres, accessed exclusively with the service-role
  key from the API routes. Row level security is enabled with no public
  policies, so the anon key (which we never ship) can read nothing.
- **Identity**: posting, voting, and commenting use signed-in accounts. Rate
  limits also use hashed client addresses.
- **Trust model**: the server re-validates every uploaded plan against
  `factoryProjectSchema` and recomputes all stat-card numbers (power, machine
  count, highest tier, needs/outputs) with the real solver — clients cannot
  fabricate stats.

## Setup

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. In the SQL editor, run the contents of `supabase/schema.sql`.
3. In **Project Settings → API**, copy:
   - the project URL → `SUPABASE_URL`
   - the `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY`
4. Pick any random string for `COMMUNITY_HASH_SALT`.
5. Add all three to `.env.local` (dev) and the production host's environment.

Without these variables the rest of the app works normally; the community
endpoints return 503 and the hub page shows an error banner.

For a database-free deployment, set `NEXT_PUBLIC_ENABLE_ONLINE_FEATURES=false`
before building Next.js and keep it set on the server. The planner hides
Community, accounts, cloud and live sharing, and the blueprint library. Local
plans still save in the browser and share as self-contained links, codes, or
files. Database-backed endpoints answer as unconfigured. To enable the online
features later, configure the database and rebuild with the flag set to
`true` or omitted. The optional live service can be left stopped until then.

## Behavior notes

- Uploads: max 3 MB JSON, name ≤ 80 chars, description ≤ 2000 chars.
  Limits apply per account, per address, and across the site. Empty plans are rejected.
- Votes: one per plan per signed-in account. Sending the same vote again retracts it.
  Counters are recomputed from the votes table on every vote, so they
  self-heal under races.
- Views: counted when a plan's preview/detail is opened, not per list render.
- Downloads: counted via the download endpoint (JSON download and
  "Open in editor" both use it).
- Previews: PNG captures of the board (up to 4 MB) are uploaded separately to the
  `plan-previews` storage bucket. Cards without a photo can fall back to resource icons.
- Accounts: dead-simple username + password (`community_users`). Passwords are
  scrypt-hashed; sessions are HMAC-signed httpOnly cookies (180 days), signed
  with `COMMUNITY_HASH_SALT`. No email, no password reset. Sharing requires an
  account; posts carry `user_id`/`author_name`, and only the signed-in owner
  can update a post ("Post as → Update …" in the share dialog). The owner or a
  moderator can take it down.
- Moderation: set `COMMUNITY_ADMIN_TOKEN` and send it as the `x-admin-token`
  header on `DELETE /api/community/plans/<id>` to take down any post, or
  delete rows directly in the Supabase dashboard.
