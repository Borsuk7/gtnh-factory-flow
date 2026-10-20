# Cloud plans and live editing

Plans kept in the player's account, shared with other accounts as editors and edited together live, with everyone's
cursor on the board. The game (the in-game planner) and this website edit the same plans the same way. The contract
both sides build against is `docs/design/cloud-live.md` in the game's repository (`jackwrichards/gtnh-planner-mod`);
this file is the website's side of it.

## The parts

| Part | Where | What it does |
|---|---|---|
| Plan additions | `src/lib/model/schemas.ts`, `types.ts` | `gtnhplanner` (the game's own data, opaque, 64 KB a thing), `primaryView`, `tasks`, `taskItems`, `taskComments` |
| Op engine | `src/lib/live/ops.ts` | put / patch / del / meta, apply, diff, invert, JSON equality; `live-vectors.json` pins every rule and the game runs the same file |
| Client engine | `src/lib/live/client-state.ts` | confirmed + pending, echoes, resync after a reconnect, undo by inverse |
| Protocol | `src/lib/live/protocol.ts` | frame types, doc keys, limits, colours, `liveSocketUrl` |
| Batch checks | `src/lib/live/validate.ts`, `src/live/batch.ts` | each thing a batch puts or patches must pass its collection's schema, plan fields their field's; what is stored is the schema's output |
| REST | `src/app/api/library/...`, `src/app/api/accounts/search` | members, `?owner=`, the lease refusal, notices to the live service (`src/lib/server/cloud-plans.ts`) |
| Live service | `src/live/` | the WebSocket server: rooms (`room.ts`, the plan held in `doc.ts`), journal, the flush queue, leases |
| Local database | `src/lib/server/local-db/`, `tools/local-db/serve.ts` | Postgres in-process (PGlite) behind a PostgREST stand-in |
| Test client | `tools/live/test-client.mjs` | a headless client for all of the above |
| The editor | `src/store/live-session.ts`, `src/lib/live/live-*.ts`, `src/components/live/`, `src/components/tasks/` | the open design live: edits, undo, offline, presence, sharing, task boards (below) |

A cloud plan is a `library_designs` row, addressed everywhere as `<ownerId>:<designId>` (the doc key). The schema
additions are `supabase/migrations/2026-10-14-cloud-live.sql`: `seq` (edit batches applied), `live_lease_until` and
`live_lease_token` (the lease), and `library_design_members`.

## How an edit travels

1. A client (browser or game) diffs its plan before and after the edit (`diffPlans`), keeps the batch in `pending`
   with its inverse for undo, and sends `{ t: "ops", doc, base, cid, ops }`.
2. The live service runs the room's batches one at a time, in arrival order. It stamps what is the server's to write
   (a comment's author and time, a new task's `createdBy`), stages the batch on the room's plan, checks every thing
   it touched against the plan schema (field by field for a thing only patched) and the size limit, and gives it the
   next `seq`. What is stored is the schema's output: when that differs from what the batch left (a field the schema
   does not know, a value it normalises), the ops that make it so are appended to the batch, so every client lands on
   what is stored.
3. The batch is applied to the room's plan in memory and appended to its journal; the journal writes a turn's lines
   (and all that come while its last write is on the disk) in one write and one sync. Once its line is on disk the
   batch is broadcast to everyone in the room, the sender included (its echo is its ack: the same `cid`). Nothing
   leaves the room before it is on disk: a snapshot, a flush and the ack of a resent batch wait for the journal.
4. At most every 8 s while the plan changes, and when the room closes, the room writes the plan, `seq`,
   `plan_updated_at` and `updated_at` to the database (one write, in its turn of the service's flush queue), extends
   or ends the lease, and trims the journal.

So the database sees one write per 8 s per open plan, never one per edit, and a crash loses nothing: on start the
service replays every journal over the stored plans and stores the result. A batch costs what it touches: the room
keeps its plan with an id index per collection (`src/live/doc.ts`, checked against `applyOps`), so the biggest batch on
a plan of 40,000 cards takes milliseconds.

### The lease

Opening a room sets `live_lease_until` 90 s ahead and a fresh random `live_lease_token`, and reads the plan in the same
request; the room renews it every 30 s. While it is in the future, the REST plan PUT refuses a plan body with
`409 { live: true }` (metadata still goes through), and its write is conditional on the lease, so a lease taken
between its read and its write still wins. There is one live service per database: it takes leases without asking
whose they were, so a restart picks its own back up at once.

Every renewal, flush and release is conditional on the room's token, and a REST plan save (made once a lease
lapsed) clears it. A room whose write finds the token changed has lost its lease: it writes nothing more and closes
everyone's socket with 1012, as a restart would; they join again, which opens the plan afresh from the database with
the room's journal replayed on top. Flushes and renewals only touch designs that are not tombstoned, so a deleted
plan is never written back.

Each renewal also reads the plan's members again: a sharing change whose notice never reached the service takes
effect within 30 s, dropping anyone no longer shared.

### Rooms and the database

- A room nobody is in lingers for a minute before its last flush lets the lease go, so someone leaving and coming
  back, or a page reloading, reads and leases nothing again.
- Every write of a whole plan (and every release) waits its turn in one flush queue, four at a time across all
  rooms. Each failure rests the queue, from half a second up to 30 s, and a success lifts it; edits wait in the
  journals meanwhile.
- A room holding more than 8 MB of journalled batches the database has not taken refuses more as `rate` until a
  flush gets through.
- At most 8 plans open per account (across its sockets) and 500 in the service (`LIVE_MAX_ROOMS`). A full service
  closes a plan nobody is in and refuses the join as `rate`; the website asks again a few seconds later.

## Protocol notes beyond the contract's table

The frames are the contract's (version 1). What the service adds or decides:

- **Resent batches.** A batch whose `cid` the room already applied (resent after a reconnect, its echo lost) is
  acknowledged to its sender alone as `{ t: "ops", seq: <its original seq>, cid, ops: [] }`: nothing to apply, and
  the client drops it from `pending`. Each room keeps its last 1,000 cids, in memory and on disk beside its journal
  (`<ownerId>.<designId>.cids.json`, written by every flush before the journal is trimmed), so a resend after a
  restart is known even when its journal was already flushed. A journal replay applies a cid it holds twice once.
- **Refusals name the batch.** An `error` about a batch carries its `cid`, so the client can drop it
  (`LiveClientState.refuse`). Codes: `bad_op` (shape or schema), `too_big` (a frame over 256 KB in UTF-8 bytes, more
  than 1,000 ops, or a plan over the 3 MB upload limit), `rate`, `forbidden` (not shared with you, or not joined),
  `not_found`, `auth` (no valid session: the socket closes with 4001; a failed account lookup closes with 1013 and the client tries again), `version` (hello first, `v: 1`).
- **`rate` means not now, not never.** A batch refused as `rate` was not applied and should go again shortly (the
  website resends it after a second): over 30 batches a second, over the account's batch-work budget (250 ms of
  checking and applying a second, 1 s banked), or the room's journal backlog while the database is down. A join
  refused as `rate` (too many plans open, the service full, or the database not answering the open or the membership
  check) should be asked again after a few seconds.
- **Sizes.** Frames are measured in UTF-8 bytes before they are parsed: only an `ops` frame may be over 16 KB, and a
  frame over the 256 KB batch limit is refused by the `cid` read off its first or last kilobyte. A frame over 512 KB
  closes the socket (1009) before it is read whole, so a client must never send one: split edits into batches under
  both limits (the website keeps batches under 200 KB and 1,000 ops, and drops an edit too big to send at all).
- **Names and depth.** No object key anywhere in a batch may be `__proto__`, `constructor` or `prototype`, and no
  value may nest deeper than 64 levels of arrays and objects (a patched field 63, counted from its thing); such a
  batch is refused as `bad_op`. The game's data and a recipe's `metadata` nest at most 63 levels in any stored plan.
- **What is stored.** The plan schema's output: fields a thing's schema does not know are dropped and values it
  normalises are normalised, by ops appended to the batch (a `put` of the thing, or a `patch` of the named fields),
  which every client applies with the rest.
- **Comments and tasks.** A new comment gets `by`, `byName` and `at` from the server whatever the client sent;
  changing an existing one is its author's alone and keeps those stamps; anyone in the room may delete one. A new
  task's `createdBy` is its sender; a task put over an existing one keeps that one's; a patch cannot set or delete it.
- **Plan fields.** A `meta` op may only set fields the plan schema knows and may not delete required ones.
- **Joining again.** A `join` for a plan the connection is already in answers a snapshot only when the plan moved on
  since the last one sent to it (at most once a second), else nothing: a client that missed batches gets the plan,
  one that already has it gets no copy.
- **Reload.** A room whose journal cannot be written, or whose lease is no longer its own, closes the sockets of
  everyone in it with 1012: the client reconnects, joins again and resends what was never acknowledged.
- **Slow readers.** A socket with more than 8 MB waiting to be sent is dropped.
- **Shared and unshared** (additions to the contract's table). `{ t: "shared", doc, owner: { id, username }, name }` goes to
  EVERY open socket of an account the moment it is added to a plan, whether or not it has the plan's room open (the
  members route's internal call names who was added); `{ t: "unshared", doc }` goes to every socket of an account
  taken off a plan (or leaving it), beside the room's `kicked` for sockets that were in it. Clients show
  "<owner> shared <plan> with you" with an Open key and refresh their Shared with me list at once (`unshared` only
  refreshes it). Neither frame is replayed: an account that was offline finds the plan in `GET /api/library`'s
  `shared` list. A notice the service did not take is tried again, so a client may hear `shared` twice for one
  share and must ignore the second.
- **People.** `Person` and relayed `presence` carry `conn`, the connection, as one account can be in a plan twice (a
  game and a browser). `snapshot` carries `owner: { id, username }`.
- **Presence** is relayed to the others in the room, never stored, at most 20 frames a second per connection: between
  slots only the latest is kept, so the last position always lands.
- **Limits per connection:** 200 frames a second (more closes the socket), 10 joins a second, 30 batches a second, 8
  plans open, 500 selected ids in a presence frame. **Per account:** 16 sockets, 8 plans open across them, 250 ms of
  batch work a second, 30 socket upgrades a minute. **Per address:** 60 socket upgrades a minute (more answer 429
  before the upgrade). The address is the `X-Client-Ip` header when the request comes from loopback (Caddy sets it,
  overwriting the client's; `CF-Connecting-IP` when it is missing), otherwise the socket's own. An account is looked
  up for a session at most once a minute.
- **Pings.** Clients send `{ t: "ping" }` every 25 s (Cloudflare drops a socket idle for 100 s); the server also pings
  at the WebSocket level and drops a connection silent for 90 s.
- **Origins.** A browser's upgrade must come from an origin in `LIVE_ALLOWED_ORIGINS` (403 otherwise); a client that
  sends no Origin (the game) is let in. Sign-in is the `gtnh_session` cookie on the upgrade, checked with
  `src/lib/server/session.ts`, the module the website uses. When the database cannot say whose the session is, the socket
  closes with 1013 (try again later), never 4001.

HTTP on the same port: `GET /live/health` (`{ ok, rooms, connections, flushBacklog }`), `GET /live/nearby` (below), and,
for the Next.js routes only,
`POST /internal/members` (`{ doc, members, added?, removed?, owner?, name? }`: `added` and `removed` are account ids that just joined or left, `owner` and `name` what `shared` carries), `/internal/deleted` (`{ doc }`) and `/internal/shutdown` (store
everything and exit), each with `Authorization: Bearer $LIVE_INTERNAL_TOKEN`. Caddy routes only `/live` and `/live/*`
to the service, so `/internal` is never reachable from outside.

### Nearby players (for the game's share helper)

`GET /live/nearby?names=<name>,<name>,...` with the session cookie answers `{ accounts: [{ id, username }] }`: the
signed-in accounts, other than the asker, that are connected from a game (`hello` with `client: "game"`) with the
same `game.server` hash as one of the asker's own game connections **and** whose `game.mcName` is one of `names`.

- `names` are the Minecraft names the asker's game shows it (its tab list), comma separated, `[A-Za-z0-9_]{1,32}` each,
  compared without case; at most 100 are read. Without `names` the answer is empty. The game must send its own
  player's name as `game.mcName` in `hello` to be found.
- So the server hash alone (an unsalted SHA-256 of the address, which anyone can compute) lists nobody: the asker
  must already see a player in the game to learn their account.
- 20 asks a minute per account and 60 per address; more answer `429`. No session: `401`.

## The editor

The website joins the room of the design on the canvas when it is a cloud plan: one of ours the account holds
(`<my id>:<design id>`), or this device's copy of a plan shared with us. One socket per browser tab
(`src/store/live-session.ts`); the rules the stores keep are in `src/store/CLAUDE.md` (Live plans).

- Every edit the store makes outside a quiet change is shaped (`live-shape.ts`: `metadata`, `name`, `view`,
  `poolCellRatios` and GregTech runtime tables left out), diffed, and sent as one batch; others' batches land as the
  difference they make to the view, so untouched cards keep their identity. Undo applies recorded inverses of your
  own edits only.
- Pending batches are kept in IndexedDB per plan and tab and sent again after a reconnect; a closed tab's are adopted
  by the next tab to open the plan. Each tab joins for itself rather than one tab holding the connection for all:
  no tab depends on another staying open, at the cost of a socket a tab.
- Presence: the pointer on the board at most 10 a second, the selection when it changes, drawn for others by
  `LivePresenceLayer`; faces of who is here on the plan bar.
- Sharing: the top bar's Share (members, search, remove, leave) and the Library's Shared with me, which the live
  service's `shared` and `unshared` frames keep current, with a notice and an Open key. Publish (the
  community post) is separate and never shares the live plan. A plan the service dropped this tab from (unshared,
  deleted, refused) is not asked for again while its design is still here; once that design is gone, a design for the
  same plan (shared again and opened from Shared with me) joins. Leaving a plan yourself shows no "removed" notice
  (`noteLeavingPlan`).
- Task boards: `src/lib/tasks/` (pure edits as the game's TaskEdits and TaskChain, fractional order keys) and
  `src/components/tasks/`; a task board is a plan of its own kind (`primaryView: "tasks"`, made by New task board) that
  always shows its tasks, and no other plan shows tasks. A task carries `priority` (none is Medium), `movedAt` (stamped
  by a move to another column) and `blockedBy` (ids on the board, never a loop: the adding side refuses one); a thing
  (`taskItems`) is a machine (`link`), a location (`place`) or a screenshot (`picture`, an image data URL), each with
  its checkbox, or an older line of words. The website never adds locations or screenshots, it keeps and shows the
  game's. A `link` is `{ plan, node }` pointing at a card of another plan (`plan` is `<ownerId>:<designId>` for a plan in
  the account, the local design id otherwise); Add to a task on cards puts a machine thing per card in a task, linked on
  the thing (an older task's own `links` still read, as loose machines). They work on plans of this device alone too.
- The account sync never sends the body of a plan open live and treats 409 `{ live: true }` as nothing to send.
- Deviations from the contract: a member's rename of a shared plan stays on their device (the row's name is the
  owner's); board dressing (`view`) is per person, not shared live; presence from your own account (another tab, the
  game) is not drawn; an own design goes live only once the account sync has created its row, and its earlier
  snapshot undo steps end there.

## REST

All signed in by the session cookie. A design id is unique per owner only, so every design route takes
`?owner=<ownerId>` (absent: your own).

- `GET /api/library`: as before (tombstones included), each design with `members: [{ id, username }]`, plus
  `shared: [{ ownerId, ownerName, id, name, icon, updatedAt, planUpdatedAt, members }]`.
- `GET /api/library/designs/<id>?owner=`: the plan, for its owner or a member: `{ design, plan, ownerId, role, seq,
  live }`.
- `PUT /api/library/designs/<id>?owner=`: as before for the owner; a member may save the plan and its name. A plan body
  while the lease is held: `409 { live: true }`.
- `DELETE /api/library/designs/<id>`: the owner only; drops every member and tells the live service.
- `GET /api/library/designs/<id>/members?owner=`: `{ ownerId, ownerName, role, members }`.
- `PUT /api/library/designs/<id>/members/<userId>`: the owner shares (20 accounts a plan at most; 30 new shares an
  hour per owner across their plans, then `429`).
- `DELETE /api/library/designs/<id>/members/<userId>?owner=`: the owner unshares, or a member leaves (their own id).
- `GET /api/accounts/search?q=<prefix>`: `{ accounts: [{ id, username }] }`, up to 10, case-insensitive, you left out;
  60 a minute.

Sharing changes and deletes are posted to the live service when `LIVE_INTERNAL_URL` and `LIVE_INTERNAL_TOKEN` are set,
so open rooms update (`members`) and anyone no longer allowed is dropped (`kicked`). A notice the service does not take
(down, restarting) is tried again in the background after 1, 4 and 15 s; each open room also reads its members again
at every lease renewal, so a lost notice is late by at most 30 s.

## Running it locally

```bash
npm run dev:local
```

starts the local database on 127.0.0.1:54329 (data in `scratch/local-db/pgdata`), the live service on :3001 (journal
in `scratch/local-db/live-journal`) and `next dev` on :3000, with `LOCAL_DB=1`, a development-only
`COMMUNITY_HASH_SALT` and `NEXT_PUBLIC_LIVE_URL=ws://localhost:3001/live`. No Supabase credentials anywhere. Accounts
made there exist only there. Ctrl+C stops all three; the live service stores its open plans first.

The pieces alone: `npm run local-db`, `npm run live` (with `LOCAL_DB=1`, `COMMUNITY_HASH_SALT` and friends set),
`npm run dev`. Delete `scratch/local-db/` for a fresh database.

Two people: two browser profiles, a browser and the dev game (`call 'library?url=http://localhost:3000'`), or the
test client:

```bash
C="node tools/live/test-client.mjs"
$C --user ann --password annpass1 register
$C --user bob --password bobpass1 register
$C --user ann --password annpass1 create "Shared test"        # prints { doc, designId }
$C --user ann --password annpass1 share <designId> bob
$C --user bob --password bobpass1 --game world-1 join <doc>    # prints frames; type `presence 10 20` or `ops [...]`
$C --user ann --password annpass1 send <doc> '[{"o":"meta","f":{"primaryView":"tasks"}}]'
```

## Production

`npm run build:live` bundles the service to `dist-live/live.mjs` (esbuild; packages stay in `node_modules`), run with
`node dist-live/live.mjs` as the systemd unit `gtnh-live` on 127.0.0.1:3001. `next build` and `next start` are
unchanged. Environment: `COMMUNITY_HASH_SALT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LIVE_PORT`,
`LIVE_HOST`, `LIVE_JOURNAL_DIR`, `LIVE_INTERNAL_TOKEN`, `LIVE_ALLOWED_ORIGINS`, `LIVE_MAX_ROOMS` (optional, default 500),
`NODE_ENV=production`. `LOCAL_DB=1` with `NODE_ENV=production` stops both the website and the service at startup. The website
needs `LIVE_INTERNAL_URL` and `LIVE_INTERNAL_TOKEN` at run time and `NEXT_PUBLIC_LIVE_URL` at build time (unset:
no live features). The rollout, staging first, is `docs/live-rollout.md`.

## Tests

- `src/store/live-session.test.ts`: the stores against a fake service speaking the protocol with the real engine
  (what an edit sends, remote batches, undo of own edits, offline and resend, a closed tab's edits, refusals,
  removal, nothing without the variable). `src/lib/library/library-sync-live.test.ts`: the sync beside live plans.
  `src/lib/tasks/*.test.ts`: order keys and task edits.
- In the real app, on `npm run dev:local`: `scratch/probes/live-share.mjs`, `live-shared-notice.mjs`, `live-tasks.mjs` and `live-extra.mjs`
  (two headless accounts: share, edits both ways, cursors, selections, undo, removal, the task board on both,
  offline edits, linked cards, a signed-out board). Development builds expose the stores as `window.__gtnhLive`
  (and `drop()`, which cuts the socket as a lost network would). Sign-ins are rate limited: the probes keep their
  sessions in `scratch/probes/.session-*.json`.

- `src/lib/live/ops.test.ts` (the vectors), `validate.test.ts`.
- `src/lib/server/local-db/postgrest.test.ts`: every query shape against real Postgres.
- `src/app/api/library/cloud-plans.test.ts`: sharing, members, the lease refusal, deletes, search, the notices.
- `src/live/service.test.ts`: the service in-process with real sockets: two editors converging, reconnects, the
  journal after a crash, refusals, unsharing and deleting, limits, comments, presence, the lease against REST, a lost
  lease, origins, lingering rooms, room caps, members checked in the room's turn and re-read at renewals, upgrade
  limits, nearby by names, slow readers, frame sizes, what is stored.
- `src/live/doc.test.ts` (the room's plan against `applyOps`, and the biggest batch on a 40,000-card plan under
  50 ms), `room.test.ts` (the order of a room's writes, group commit, journal backlog and failure, lease loss, task
  stamps), `flush-queue.test.ts`, `src/lib/server/cloud-plans.test.ts` (notices tried again).
