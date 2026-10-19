# Rollout: cloud plans and live editing

## Go: the master plan (2026-10-16)

The switch makes the new site (staging, `live-backport`, 4.0.0) the one at `gtnhplanner.com`, publishes the mod's
`0.2.0-beta.2`, and moves the recipe data from the 2.9.0-beta-2 export to an RC-2 export. Nobody should see more than
a slow minute. Every phase can be undone on its own.

How the droplet stands (checked 2026-10-16): 4 GB of memory and a 2 GB swapfile. `gtnh-flow` (the old site, 3.11.1,
port 3000, `/opt/gtnh-flow`) holds about 2.4 GB with the beta-2 recipe data loaded. Staging is `gtnh-flow-next`
(3002, capped at 900 MB, release in `/opt/shared/cloud-live-release`) and `gtnh-live` (3001). Staging has no recipe
data of its own: Caddy sends its `/api/datasets/*` to 3000. The droplet has room for one copy of the recipe data, not
two, so staging cannot try the RC-2 data while the old site runs beta-2. `/opt/deploy.sh` builds `main` of
`jackwrichards/gtnh-factory-flow` into `/opt/gtnh-flow`. The Supabase migration is already in production.

### Where it stands (2026-10-17)

- **Phase B done** about 02:29 UTC. Right after it the new site hung for minutes: a Community plan's stats refresh solved on the request thread with the homegrown simplex, because the bundled build looked for `highs.wasm` under `/ROOT/node_modules/highs/build`. Fixed live with a symlink there (`/ROOT/node_modules/highs/build` to a release's `node_modules/highs/build`) and in code (fe7cbfe7). Keep the symlink until a release built from fe7cbfe7 or later runs.
- **Phase C done** about 04:55 UTC, a little differently from the steps below: `gtnh-flow-rc2` (port 3003) runs `/opt/releases/live-backport-rc2`, a hard-linked copy of the release whose `public/datasets/gtnh` points at `/opt/shared/gtnh-datasets-rc2`: its own manifest (RC-2 default, beta-2 kept) with links to both datasets in `/opt/shared/gtnh-datasets`. The shared manifest was left alone so the old site never tried to load RC-2. Caddy sends everything but `@live` to 3003 in every block (`Caddyfile.pre-rc2` is the one before). `gtnh-flow` and `gtnh-flow-next` are stopped and disabled; the extra swap is gone.
- **Deploys until Phase D:** build in WSL (`git clone --depth 1 --branch main`, the last build's `.env.local` of `NEXT_PUBLIC_*` lines, node from `~/.local/node/bin`, `npm ci`, `npm run build`), upload `.next` without its cache into a `cp -al` copy of the running release (remove the copy's `.next` first: its files are links to the live one's), check it on a spare port (`systemd-run` with `/opt/shared/live.env`, no prewarm, a 512 MB heap: about 280 MB), then point `gtnh-flow-rc2`'s `WorkingDirectory` at it and restart (the restart returns after the prewarm, about 40 s; the unit before is kept as `.pre-<version>`). Only `.next` changes while `package.json`, `public/` and `src/live` do not. The droplet has no memory to build while the site runs. Now: `/opt/releases/live-backport-fe5aa84` (4.3.0, 2026-10-19 03:45 UTC: on port 3013 first at about 330 MB, the restart back in 33 s; `.pre-430` is the unit before, and `live-backport-052e6e2` stays for a rollback). `gtnh-live` still runs from `/opt/releases/live-backport-5c90dd4`: keep that folder. A "resource popularity aggregation failed" timeout at start is usual.
- **Phase D** is next: back to the usual names and `/opt/deploy.sh`. Until then a deploy must not restart `gtnh-flow` into port 3000 expecting traffic: nothing points there.

### Phase A. Before the day (nothing players can see)

1. **RC-2 recipe data.** Export from the RC-2 pack with the oracle mod and rebuild as `local-2.9.0-rc-2`
   (`tools/dataset-pipeline/CLAUDE.md`). A fresh export re-mints about 37,000 crafting, furnace, bee, crop and essentia
   recipe ids: carry the beta-2 ids over (match recipes by content key, as `graft-sparge.js` does) so saved plans keep
   their recipes. Run `normalize-fluid-icon-alpha.mjs --rename`. Regenerate the mod's machine data and goldens from
   it (`tools/audits/export-mod-machine-data.mjs`) and re-run the mod's tests.
2. **Test the RC-2 data locally** (`npm run dev:local` with the new files in `public/datasets/gtnh`): item search,
   the Nanochip Assembly Complex's circuit recipes, every Community plan in the old-against-new comparison
   (`parity/` in the mod worktree: the same 60 plans solve the same apart from what RC-2 changed), and the tour at
   1280x720 and 1920x1080.
3. **Upload it without using it:** copy `local-2.9.0-rc-2` to `/opt/shared/gtnh-datasets/` but leave it out of
   `datasets.manifest.json`, so nothing reads it yet. Check the disk (11 GB free; a dataset is about 0.7 GB).
4. **Carry-over checks on staging:**
   - A browser's own plans: copy a `gtnhplanner.com` browser profile's local storage into a `new.gtnhplanner.com`
     one (headless) and open its plans: Build, Solve and Pool plans open as plan-mode boards with their numbers.
   - Sign-in: a session cookie made by the old site is accepted by the new one (same `COMMUNITY_HASH_SALT`), so
     signed-in players stay signed in.
   - beta.1 games: the routes the beta.1 jar calls (`/api/community/auth/*`, `/api/community/plans*`,
     `/api/datasets/*`, `/api/feedback`) answer the same on staging.
5. **Freeze:** the last staging build is the build that goes live. The mod's draft release is final and its jar
   was smoke-tested in the full pack.
6. **Pick the hour:** the quietest hour in Umami's traffic. Tell the Discord thread beforehand.

### Phase B. The switch (no downtime)

1. **Backups:** copy `/etc/caddy/Caddyfile`, `/opt/shared/env.local`, both site units and
   `/opt/shared/gtnh-datasets/datasets.manifest.json` beside themselves with a `.pre-go` suffix.
2. **Give staging room to serve everyone.** It restarts, and only testers are on it:
   `sed -i 's/^MemoryMax=900M/MemoryMax=1400M/; s/max-old-space-size=600/max-old-space-size=1000/'
   /etc/systemd/system/gtnh-flow-next.service && systemctl daemon-reload && systemctl restart gtnh-flow-next`.
   Then `curl -s http://127.0.0.1:3002/api/version` says 4.0.0.
3. **Point gtnhplanner.com at the new site.** In the `gtnhplanner.com` block (and the `http://<ip>` block), keep
   `handle_path /umami/*` and the log, and replace `reverse_proxy 127.0.0.1:3000 { header_up X-Client-Ip {client_ip} }`
   with the three handles the `new.gtnhplanner.com` block has: `@live` to 3001, `/api/datasets/*` to 3000, the rest
   to 3002. `caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy`. A reload keeps open
   connections, so nobody is cut off. The old site keeps running, serving only the recipe data.
4. **Smoke test:**
   - `https://gtnhplanner.com/api/version` says 4.0.0 and `https://gtnhplanner.com/live/health` answers.
   - A page loads, Community lists, and a plan opens from it.
   - Sign in, share a plan with a second account, and see the second cursor.
   - The tour starts from the ? key.
   - A beta.1 game can still sign in and open Community.
5. **GitHub:**
   - Website: `git push origin live-backport:main`, a fast-forward.
   - Mod: `git push origin mod-live-backport:main`, also a fast-forward.
   - Publish the draft: `gh release edit 0.2.0-beta.2 --repo jackwrichards/gtnh-planner-mod --draft=false`. Never
     replace its text: the owner's pictures are in it.
   - The order matters: a beta.2 game asks `/live/health` before it turns on cloud plans, and its quest things need
     the new site.
6. **Rollback, if needed:** put `Caddyfile.pre-go` back and `systemctl reload caddy`. It is one step and instant.
   The old site ignores the new columns; plans it saves lose their task boards.

### Phase C. RC-2 data (same day, once B is calm)

The new site loads the RC-2 data, and the old site, which only serves recipe data now, is stopped.

1. **Room for both copies while the new one warms.** Grow the swap to 6 GB for the hour:
   `fallocate -l 4G /swapfile2 && chmod 600 /swapfile2 && mkswap /swapfile2 && swapon /swapfile2`.
2. **Publish the data:** add `local-2.9.0-rc-2` to the manifest with `rebuild-manifest.mjs`, and set it as
   `latestStableVersion`, which the website picks by default (`pickDefaultDatasetVersion`). Keep `local-2.9.0-beta-2`
   listed so plans that name it still resolve.
3. **Start a second copy of the new site on 3003 that serves the data:** a unit `gtnh-flow-rc2` copied from
   `gtnh-flow-next`, with these changes:
   - the same release and the old site's memory and heap (no MemoryMax, `--max-old-space-size=3072`);
   - `PORT=3003`;
   - the old site's `ExecStartPost` prewarm, pointed at 3003 and `local-2.9.0-rc-2`.
   
   Start it and wait until the prewarm returns. Nothing points at it yet.
4. **Switch everything to it at once:** in both site blocks, send the rest and `/api/datasets/*` to 3003 (`@live`
   stays on 3001). `caddy validate`, then `systemctl reload caddy`. Item search now shows RC-2 recipes, for example
   the Nanochip Assembly Complex's.
5. **Retire the others:**
   - `systemctl stop gtnh-flow gtnh-flow-next && systemctl disable gtnh-flow gtnh-flow-next`.
   - Remove the extra swap: `swapoff /swapfile2 && rm /swapfile2`.
   - Phase D folds 3003 back into the usual `gtnh-flow` name.
6. **Rollback:** `systemctl start gtnh-flow gtnh-flow-next`, put the Phase B Caddyfile back and reload. The beta-2 data is untouched.

### Phase D. Tidy up (a later quiet moment, no downtime)

Back to one site under the usual names, so `/opt/deploy.sh` deploys the new code. Traffic stays on 3003 until 3000 is
warm, so the deploy's restart touches nobody. Add the extra swap of Phase C again for the hour, since both copies hold
the data while 3000 warms.

1. **The live address:** add `NEXT_PUBLIC_LIVE_URL=/live` to `/opt/shared/env.local`.
2. **The deploy script:** add `npm run build:live` after `npm run build` in `/opt/deploy.sh`.
3. **The site unit:** give `gtnh-flow` an `EnvironmentFile=/opt/shared/live.env` drop-in and the RC-2 prewarm.
4. **Deploy:** run `/opt/deploy.sh`, which builds `main` (now 4.0.0) into `/opt/gtnh-flow`.
5. **The live service:** point `gtnh-live`'s `WorkingDirectory` at `/opt/gtnh-flow` and restart it.
6. **Caddy:** once 3000's prewarm returns, set the `gtnhplanner.com` block back to 3000 for everything but `@live`.
7. **The interim copy:** stop and disable `gtnh-flow-rc2`, and remove the extra swap.
8. **new.gtnhplanner.com:** remove its Caddy block and its Cloudflare CNAME, or keep it as a test site.

### Phase E. After

- **The first day:** watch the logs: `journalctl -u gtnh-flow-next -u gtnh-live -f` (after D, `-u gtnh-flow`),
  `/live/health`, and feedback issues on GitHub.
- **Moving the pack:** when GTNH moves past RC-2, export again and repeat Phase C. The live site stays up throughout.

The rest of this file is the plan as written before staging, with what was actually deployed in section 2.7.

## The plan

The production runbook for the `cloud-live` branch: the database migration, staging at `new.gtnhplanner.com`, the
switch, the rollback, and the merge into `main`. Architecture and protocol: `docs/live.md`.

Every step can be undone on its own:

- The migration only adds (three columns, one table); the code on `main` never reads them.
- Staging is a second Next.js instance and the live service beside the running site; stopping them changes nothing
  for `gtnhplanner.com`.
- The switch is one Caddy change, and so is the rollback.
- An empty `NEXT_PUBLIC_LIVE_URL` at build time turns every live feature off in the website.

Values in `<angle brackets>` are filled in on the day. `$REL` is the staging release directory.

## 0. Look first

On the droplet, read how the running site is set up, and copy it rather than guessing:

```bash
systemctl cat gtnh-flow                 # user, WorkingDirectory, EnvironmentFile(s), Environment=, ExecStart, node path
ls -la /opt/releases/                   # the current release
readlink -f /opt/releases/<current>/public/datasets/gtnh   # how datasets reach a release (a link to /opt/shared/gtnh-datasets?)
cat /etc/caddy/Caddyfile                # the gtnhplanner.com site block: TLS, headers (X-Client-Ip), logs, the upstream :3000
free -m                                 # a second Next.js needs memory: the site caps its heap at 3 GB
node --version                          # 20 or newer
```

Note in particular the `gtnh-flow` unit's `User=`, its env file (the rest of this file calls it
`/opt/shared/env.local`), its `NODE_OPTIONS` heap cap, `GTNH_PREWARM_ON_STARTUP`, and how the Caddy block sets
`X-Client-Ip` and its TLS. If memory is short, give staging a smaller heap (`--max-old-space-size=1536`) for the test
period.

Confirm the session secret is set for the running site, without printing it: the website signs sessions with a
public fallback secret when `COMMUNITY_HASH_SALT` is missing (and now warns about it at startup), and the live service
refuses to start without it.

```bash
sudo grep -c '^COMMUNITY_HASH_SALT=..*' /opt/shared/env.local      # 1 (0: stop here and set it first)
systemctl show gtnh-flow -p Environment | grep -c COMMUNITY_HASH_SALT   # 0 unless the unit sets it itself
sudo grep -c '^LOCAL_DB=' /opt/shared/env.local                     # 0: LOCAL_DB is development only
```

After any restart of a site built from `cloud-live`, `journalctl -u <unit> | grep "COMMUNITY_HASH_SALT is not set"`
must find nothing. With `LOCAL_DB=1` and `NODE_ENV=production` neither the website nor the live service starts.

## 1. The migration (Supabase, additive)

In the Supabase SQL editor of the production project, run `supabase/migrations/2026-10-14-cloud-live.sql` as it is in
the branch (the same SQL is at the end of `supabase/schema.sql`). It is idempotent:

```sql
alter table library_designs add column if not exists seq bigint not null default 0;
alter table library_designs add column if not exists live_lease_until timestamptz;
alter table library_designs add column if not exists live_lease_token text;

create table if not exists library_design_members (
  owner_id uuid not null references community_users (id) on delete cascade,
  design_id text not null,
  member_id uuid not null references community_users (id) on delete cascade,
  role text not null default 'editor' check (role in ('editor')),
  added_at timestamptz not null default now(),
  primary key (owner_id, design_id, member_id),
  foreign key (owner_id, design_id) references library_designs (user_id, id) on delete cascade
);

create index if not exists library_design_members_member on library_design_members (member_id);

alter table library_design_members enable row level security;
```

`add column ... default 0` on `library_designs` rewrites nothing in Postgres 11 and later (a constant default); the
table is small either way. `live_lease_token` is the live service's lease: every write it makes is conditional on it,
so a room that lost its lease never writes over the plan. Check:

```sql
select column_name, data_type from information_schema.columns
 where table_name = 'library_designs' and column_name in ('seq', 'live_lease_until', 'live_lease_token');   -- 3 rows
select relrowsecurity from pg_class where relname = 'library_design_members';   -- true
select count(*) from library_design_members;                                      -- 0
```

Undo (only if nothing uses them yet): `drop table library_design_members; alter table library_designs drop column
live_lease_token, drop column live_lease_until, drop column seq;`.

If the earlier version of this migration (without `live_lease_token`) was already applied somewhere, run the file
again: it is idempotent and adds only the missing column.

## 2. Staging at new.gtnhplanner.com

Two new services on the production database, beside the running site:

| Unit | Listens | Runs |
|---|---|---|
| `gtnh-flow-next` | 127.0.0.1:3002 | `next start` from the `cloud-live` release |
| `gtnh-live` | 127.0.0.1:3001 | `node dist-live/live.mjs` from the same release |

Session cookies are host-only, so staging has its own sign-in (the same accounts and passwords). The owner tests there
with plans they don't mind losing. While staging runs, the main site (the old code) does not know about leases: a plan
saved on `gtnhplanner.com` while it is open live on staging can be overwritten by the live service's next flush.

### 2.1 Secrets and directories

```bash
sudo install -d -o <app user> -g <app user> -m 750 /opt/shared/live-journal
openssl rand -hex 32        # the LIVE_INTERNAL_TOKEN
sudo tee /opt/shared/live.env > /dev/null <<'EOF'
LIVE_PORT=3001
LIVE_HOST=127.0.0.1
LIVE_JOURNAL_DIR=/opt/shared/live-journal
LIVE_INTERNAL_URL=http://127.0.0.1:3001
LIVE_INTERNAL_TOKEN=<the token>
LIVE_ALLOWED_ORIGINS=https://new.gtnhplanner.com,https://gtnhplanner.com
# Optional: plans open at once in the service (default 500).
# LIVE_MAX_ROOMS=500
EOF
sudo chown root:<app user> /opt/shared/live.env && sudo chmod 640 /opt/shared/live.env
```

`COMMUNITY_HASH_SALT`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come from the site's existing env file; the live
service must use the same `COMMUNITY_HASH_SALT` as the website, or no session will verify.

### 2.2 Build the release

As the app user:

```bash
REL=/opt/releases/cloud-live-$(date +%Y%m%d-%H%M)
git clone --branch cloud-live --depth 1 https://github.com/jackwrichards/gtnh-factory-flow.git "$REL"
cd "$REL"
npm ci
# datasets, exactly as the current release has them (see step 0), e.g.:
ln -s /opt/shared/gtnh-datasets public/datasets/gtnh
# NEXT_PUBLIC_* values are baked in at build time. "/live" means "/live on whatever host served the page"
# (src/lib/live/protocol.ts, liveSocketUrl), so this one build works on new.gtnhplanner.com now and on
# gtnhplanner.com after the switch, and the host-only session cookie always goes with the socket.
set -a; . /opt/shared/env.local; set +a          # the same build-time env the site is built with
NEXT_PUBLIC_LIVE_URL=/live npm run build
npm run build:live                                # dist-live/live.mjs
```

(`NEXT_PUBLIC_LIVE_URL=wss://new.gtnhplanner.com/live` also works for staging, but then the switch needs a rebuild
with `wss://gtnhplanner.com/live`: a page on one host cannot carry the other host's cookie.)

### 2.3 The units

`/etc/systemd/system/gtnh-live.service`:

```ini
[Unit]
Description=GTNH Planner live service (live plan editing over WebSockets)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<app user>
WorkingDirectory=<REL>
EnvironmentFile=/opt/shared/env.local
EnvironmentFile=/opt/shared/live.env
Environment=NODE_ENV=production
ExecStart=<node path, as in gtnh-flow> dist-live/live.mjs
Restart=always
RestartSec=2
# SIGTERM stores every open plan and lets its lease go before exiting.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/gtnh-flow-next.service`: a copy of `gtnh-flow`'s unit (from step 0) with these differences:

```ini
[Unit]
Description=GTNH Factory Flow, cloud-live staging (new.gtnhplanner.com)
After=network-online.target gtnh-live.service

[Service]
WorkingDirectory=<REL>
EnvironmentFile=/opt/shared/env.local
EnvironmentFile=/opt/shared/live.env
Environment=NODE_ENV=production
Environment=PORT=3002
Environment=HOSTNAME=127.0.0.1
# plus gtnh-flow's own Environment= lines (NODE_OPTIONS heap cap, GTNH_PREWARM_ON_STARTUP=1, ...)
ExecStart=<node path> node_modules/next/dist/bin/next start -p 3002 -H 127.0.0.1
Restart=always
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gtnh-live gtnh-flow-next
systemctl status gtnh-live gtnh-flow-next --no-pager
curl -s http://127.0.0.1:3001/live/health          # {"ok":true,"rooms":0,"connections":0}
curl -sI http://127.0.0.1:3002/ | head -1          # HTTP/1.1 200 OK
journalctl -u gtnh-live -n 20 --no-pager           # "[live] listening on 127.0.0.1:3001, origins ..."
```

### 2.4 Cloudflare DNS

In the `gtnhplanner.com` zone: a record `new`, proxied (orange cloud), pointing where `gtnhplanner.com` points (an `A`
record to the droplet's address, or a `CNAME` to `gtnhplanner.com`). WebSockets are on by default (Network,
WebSockets); check the toggle. Cloudflare closes a WebSocket idle for 100 s; clients ping every 25 s.

### 2.5 Caddy

Add a site block for `new.gtnhplanner.com` beside the existing one. Copy the `gtnhplanner.com` block's TLS, logging
and header lines exactly (the `X-Client-Ip` header, the Cloudflare trusted proxies, any emergency rules), and change
only the routing:

```caddy
new.gtnhplanner.com {
	# ... the gtnhplanner.com block's tls / log / header / trusted_proxies lines, unchanged ...

	@live path /live /live/*
	handle @live {
		# WebSocket upgrades pass through reverse_proxy as they are.
		reverse_proxy 127.0.0.1:3001 {
			# The client's address, as the site's own block sets it (Cloudflare's
			# CF-Connecting-IP, trusted only from Cloudflare's ranges).
			header_up X-Client-Ip {client_ip}
		}
	}
	handle {
		reverse_proxy 127.0.0.1:3002 {
			# ... the same header_up lines as the gtnhplanner.com block ...
		}
	}
}
```

Only `/live` and `/live/*` reach the live service, so its `/internal/*` endpoints stay unreachable from outside.

The live service limits socket upgrades (60 a minute) and `/live/nearby` (60 a minute) per client address. It
listens on loopback, so every request seems to come from Caddy: it takes the address from `X-Client-Ip` (falling back
to `CF-Connecting-IP`), and only on requests from loopback. The `header_up X-Client-Ip {client_ip}` line above
overwrites whatever a client sends; `{client_ip}` is the real client only with Cloudflare's ranges in Caddy's
`trusted_proxies` (the main block's global options already have them if its `X-Client-Ip` works: copy what it does).
Without it every player shares one address and the limits bite everyone at once.

TLS: if the existing block uses a Cloudflare origin certificate (`tls <cert> <key>`), check it covers the new name
(`openssl x509 -in <cert> -noout -ext subjectAltName`: `*.gtnhplanner.com` does); if it does not, issue one that
does. If Caddy gets its own certificates, behind the Cloudflare proxy only the HTTP challenge works, so "Always Use
HTTPS" must not intercept `/.well-known/acme-challenge/`, or use the DNS challenge as the main block does.

```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 2.6 Check staging

From any machine:

```bash
curl -sI https://new.gtnhplanner.com/ | head -1                                    # 200
curl -s https://new.gtnhplanner.com/live/health                                    # {"ok":true,...,"flushBacklog":0}
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://new.gtnhplanner.com/internal/members   # 404 (Next.js, not the live service)

# The WebSocket upgrade through Cloudflare: expect "101 Switching Protocols" (the service then says "auth": no cookie).
curl -si -N --http1.1 --max-time 5 https://new.gtnhplanner.com/live \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://new.gtnhplanner.com" | head -1
# From another origin: 403.
curl -si -N --http1.1 --max-time 5 https://new.gtnhplanner.com/live \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://example.com" | head -1
```

With two test accounts the owner does not mind using (a checkout of the branch, `npm ci`):

```bash
C="node tools/live/test-client.mjs --base https://new.gtnhplanner.com"
$C --user <a> --password <pa> create "Staging live test"         # { doc, designId }
$C --user <a> --password <pa> share <designId> <b>
$C --user <b> --password <pb> list                                 # the plan under "shared"
$C --user <b> --password <pb> join <doc> --for 150                 # a second shell; stays past Cloudflare's 100 s
$C --user <a> --password <pa> send <doc> '[{"o":"meta","f":{"primaryView":"tasks"}}]'   # appears in the join shell
$C --user <a> --password <pa> unshare <designId> <b>               # the join shell prints "kicked"
$C --user <a> --password <pa> read <doc>                           # seq has moved, live false once everyone left
```

Then the real thing: the website on `new.gtnhplanner.com` in two browsers, and a game test build started with
`-Dgtnhplanner.library.url=https://new.gtnhplanner.com`.

Also check:

- A restart stores open plans: with a plan open, `sudo systemctl restart gtnh-live`; clients reconnect, nothing is
  lost, `/opt/shared/live-journal` is empty afterwards.
- Leases end: a minute after nobody is in a plan (rooms linger that long),
  `select count(*) from library_designs where live_lease_until > now();` is 0, and so is
  `select count(*) from library_designs where live_lease_token is not null;`.
- The flush queue keeps up: `/live/health`'s `flushBacklog` stays near 0 (it grows while the database is failing,
  as flushes rest, and drains when it is back).
- Addresses reach the service: in Caddy's access log, `/live` upgrades from ordinary use answer 101, never 429 (a 429
  for everyone at once means `X-Client-Ip` is not set on the `@live` route and every player shares one address).
- Logs: `journalctl -u gtnh-live -f`, `journalctl -u gtnh-flow-next -f`, Caddy's `/var/lib/caddy/access.log`.

Undo staging: `sudo systemctl disable --now gtnh-flow-next gtnh-live` (the live service stores its plans as it
stops), remove the Caddy block and reload, delete the DNS record.

### 2.7 What was actually deployed (2026-10-15)

Staging went up as above, with these differences, forced by the droplet: 3.9 GB of memory, of which the live site
holds about 2 GB (its prewarmed recipe data) and swap already held 0.6 GB. A second copy with its own prewarm does not
fit.

- Staging never loads recipe data: the `new.gtnhplanner.com` block sends `/api/datasets/*` to the live site on 3000,
  which has it warm (the branch never changed those routes). Staging runs with no prewarm, a 600 MB heap
  (`NODE_OPTIONS=--max-old-space-size=600`) and a hard cap (`MemoryMax=900M`, `OOMScoreAdjust=800`); the live service
  has `MemoryMax=400M`, `OOMScoreAdjust=500`. Both run as root like `gtnh-flow`, with `/usr/bin/node` (v22).
- The release is `/opt/releases/cloud-live-1792055998` (built by `/opt/build-cloud-live.sh`, the deploy script's
  steps on the branch plus `NEXT_PUBLIC_LIVE_URL=/live` in the release's `.env.local` and `npm run build:live`); its
  path is in `/opt/shared/cloud-live-release`. `deploy.sh` prunes only `r*` releases, so it never removes this one.
  `/opt/shared/live.env` holds the live settings (mode 600).
- Caddy runs as `caddy`, which cannot create files in `/var/lib/caddy`: the staging block's log,
  `/var/lib/caddy/access-new.log`, was created and given to `caddy` first (the first reload failed on it and Caddy
  kept its old config). The Caddyfile from before is `/etc/caddy/Caddyfile.before-cloud-live`. Caddy got its own
  certificate for the name; Cloudflare's SSL mode is strict and WebSockets are on.
- DNS: `new` is a proxied CNAME to `gtnhplanner.com`.
- Measured: the live site's slowest `/api/version` during the build was 0.9 s (0.1 s normally); after, 0.1 s.
  Staging uses about 230 MB, the live service about 40 MB.

For the switch on this droplet the same trick makes the Caddy change free of downtime: `gtnhplanner.com` goes to 3002
except `/api/datasets/*`, which stays on 3000 (keep `gtnh-flow` running), and `/live*` goes to 3001. Raise staging's
caps first (`MemoryMax=1400M`, heap 1000 MB): it then serves every page and save. The merge into `main` (section 4)
later brings it back to one instance with its own prewarm.

## 3. The switch

When the owner is happy with staging, `gtnhplanner.com` moves to the staging release: one change to its Caddy block.

Before (today):

```caddy
gtnhplanner.com {
	# ... tls / log / headers ...
	reverse_proxy 127.0.0.1:3000 {
		# ... header_up lines ...
	}
}
```

After:

```caddy
gtnhplanner.com {
	# ... tls / log / headers, unchanged ...
	@live path /live /live/*
	handle @live {
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Client-Ip {client_ip}
		}
	}
	handle {
		reverse_proxy 127.0.0.1:3002 {
			# ... the same header_up lines ...
		}
	}
}
```

(If the block already uses `handle` blocks or other routes, change only the upstream `127.0.0.1:3000` to
`127.0.0.1:3002` and add the `@live` handle before the others.)

```bash
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -s https://gtnhplanner.com/api/version        # the cloud-live build's version
curl -s https://gtnhplanner.com/live/health
```

The release was built with `NEXT_PUBLIC_LIVE_URL=/live`, so pages on `gtnhplanner.com` open their socket on
`gtnhplanner.com/live` with that host's cookie: nothing to rebuild. `LIVE_ALLOWED_ORIGINS` already lists
`https://gtnhplanner.com`. Players stay signed in (their cookie is `gtnhplanner.com`'s, and the secret is the same).

### Rollback

The same line back: `gtnhplanner.com`'s upstream to `127.0.0.1:3000` (the `@live` handle may stay or go), validate,
reload. The old site ignores the new columns and table. Two things to know: plans saved by the old site lose their
task boards and the game's data (its schema strips fields it does not know); and while `gtnh-live` runs, the old site
does not honour leases, so stop it too for a full rollback (`sudo systemctl stop gtnh-live`: it stores open plans
first).

## 4. Merging into main

Once the switch has held:

1. On a workstation: merge `cloud-live` into `main` (`git merge --no-ff cloud-live`), bump `APP_VERSION` in
   `src/lib/version.ts` (minor: features) and add the release's entry to `src/lib/changelog.ts`. Typecheck and the
   full suite green; push `main`.
2. The ordinary deploy builds the merged `main` for `gtnh-flow` (:3000), with two additions to the deploy from now on:
   `NEXT_PUBLIC_LIVE_URL=/live` at build time, and `npm run build:live` after `npm run build`. Add
   `EnvironmentFile=/opt/shared/live.env` to the `gtnh-flow` unit, so its routes reach the live service
   (`LIVE_INTERNAL_URL`, `LIVE_INTERNAL_TOKEN`).
3. Point `gtnh-live` at the deployed release (`WorkingDirectory=`, or a stable `current` link if the deploy keeps
   one), `daemon-reload`, `systemctl restart gtnh-live` (it stores open plans as it stops; clients reconnect).
4. Caddy: `gtnhplanner.com`'s site upstream back to `127.0.0.1:3000`, keeping the `@live` handle to 3001. Reload.
5. Stop and disable `gtnh-flow-next`; keep or remove `new.gtnhplanner.com` (its block now has nothing on 3002: remove
   it, or point it at 3000).
6. From then on every deploy restarts `gtnh-live` after `gtnh-flow`, and `/api/version` is checked as usual.

## Environment, all of it

| Variable | Who | Value |
|---|---|---|
| `COMMUNITY_HASH_SALT` | site, live | the existing secret (the same for both) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | site, live | the existing values |
| `LIVE_PORT`, `LIVE_HOST` | live | `3001`, `127.0.0.1` |
| `LIVE_JOURNAL_DIR` | live | `/opt/shared/live-journal` (outside releases: survives deploys) |
| `LIVE_INTERNAL_TOKEN` | site, live | random, `openssl rand -hex 32` |
| `LIVE_INTERNAL_URL` | site | `http://127.0.0.1:3001` |
| `LIVE_ALLOWED_ORIGINS` | live | `https://new.gtnhplanner.com,https://gtnhplanner.com` |
| `LIVE_MAX_ROOMS` | live | optional, plans open at once (default `500`) |
| `LOCAL_DB` | nobody | never set in production: with `NODE_ENV=production` neither process starts |
| `NEXT_PUBLIC_LIVE_URL` | site, build time | `/live` (empty: no live features) |
| `NODE_ENV` | site, live | `production` |
| `PORT` | staging site | `3002` |
