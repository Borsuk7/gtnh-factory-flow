# AGENTS.md

GTNH Factory Flow is a production-chain planner for GregTech: New Horizons.
Next.js App Router, TypeScript strict, Tailwind, React Flow, Zustand, Zod, Vitest.
The repo is public.

These rules apply across the repository. Read the relevant area `AGENTS.md` before
changing that area. Load references from the [docs index](docs/README.md) only when they
are relevant to the task. Update the relevant docs when a change affects what they describe.

| Area | Notes |
|---|---|
| Board: cards, drawers, boards, wires, routing, arrange, board performance | [Board guide](src/components/flow/AGENTS.md) |
| App UI: interface scale, compact mode, recipe search, inspector, sounds | [UI guide](src/components/AGENTS.md) |
| Legacy Pool worksheet | [Worksheet guide](src/components/pool/AGENTS.md) |
| Solver: plan mode, legacy modes, drawers, shared machines, verdicts | [Solver guide](src/lib/solver/AGENTS.md) |
| Machine math: overclocks, parallels, curated machine table, special machines | [Machine guide](src/lib/machines/AGENTS.md) |
| Domain model: resources, cells vs fluids, oredict context, sections, boards | [Model guide](src/lib/model/AGENTS.md) |
| Power generation | [Power guide](src/lib/power/AGENTS.md) |
| Designs, tabs, saving, account sync, plan import/export, public view | [Store guide](src/store/AGENTS.md) |
| Server, recipe API, Supabase, cloud plans, local database | [Server guide](src/lib/server/AGENTS.md) |
| Live service: live plan editing over WebSockets | [Live service guide](src/live/AGENTS.md) |
| Dataset pipeline: export, normalize, rebuild, publish | [Dataset guide](tools/dataset-pipeline/AGENTS.md) |

## Commands

```bash
npm run dev          # http://localhost:3000
npm run dev:local    # the same with a local database and the live service: no Supabase credentials
npm run typecheck
npm run test         # full vitest suite, must be green
```

Scratch harnesses are `*.local.test.ts` (excluded from the suite); run one with
`npx vitest run <file> --config vitest.local.config.ts`.

## Working rules

- Commit finished work unless told otherwise. Push only when explicitly asked. Never reset
  or revert changes you did not make. Unmerged experiments survive as `archive/*` tags.
- CI runs typecheck, the full suite and a Chromium/Firefox icon-sizing check on every PR
  and push to main. No tolerated failures. A test that pins player-facing copy changes in
  the same commit as the copy.
- Nothing generated goes in the repo root. Screenshots, probe scripts, captures and logs go
  in the session scratchpad or `scratch/` (gitignored). Old Playwright probes live in
  `scratch/probes/`. Delete screenshots once you have looked at them.
- Check UI changes in the real app with Playwright; unit tests cannot see routing,
  layering or hover. Board performance changes need a before/after profile.
- Comments state the rule and why. No dates, names or "used to" stories; git has those.

## Player-facing copy

- Plain and short: the number, the rule, the consequence. No quips, no internal jargon,
  no em dashes.
- Recipes are read-only in the UI. No manual recipe editing unless asked.

## Releases and deploys

- Deploy only when explicitly asked, once per request. Use the confirmed deployment procedure
  for this fork. The inherited GitHub deploy and dataset workflows must stay undispatched.
- Bump `APP_VERSION` in `src/lib/version.ts` once per deploy. Features get a minor bump and
  fixes get a patch bump. When a deployment exists, check its `/api/version` first. If it is
  behind `version.ts`, fold new work into the pending changelog entry. If it matches, bump
  the version and open a new entry.
- Every release has an entry in `src/lib/changelog.ts`: concrete bullets about what
  changed for players. Players open it from the header's version chip (unread dot, stamp
  `changelog-read.v1`); nothing opens by itself. Shift-click the chip for the dev menu.
- After a deploy, check `/api/version`; after a dataset publish, check the live manifest
  and the published gzip, not just local output.

## Invariants across the app

- Only GTNH 2.9 datasets are supported. Raw exporter data is normalized by the pipeline
  before UI or solver code sees it.
  Prefer exported NEI/runtime data over hand-written tables and broad fallbacks.
- Board performance is a requirement: no DOM measurement per edge or per frame, nothing
  O(nodes x edges) per frame, hover never rebuilds the board.
- Every plan that arrives (import, paste, link, community copy) opens as a NEW design.
  Nothing overwrites the open design; no app path calls `setProject`.
- Display dials (rate units, power display) repaint numbers only. They never re-solve.
- A setting with no visible control must never be persisted: players get stuck in it,
  and a `finally` that restores it is not a durable undo.

## Probing the real app

- Playwright (`playwright-core` is a devDependency), always headless: a headed run takes
  over the owner's screen. Use `waitUntil: "load"`. Write probes into `scratch/probes/`.
- A hidden browser pane never fires `requestAnimationFrame`; shim it. A fresh profile
  lands on the Welcome tab. Production has no `window.__gtnhFlow`.
- The board pane is a million px square under the scroll camera: aim at the `.react-flow`
  wrapper's box. Tooltips move `title` to `data-tip-title`.
- Compare against old behaviour with `git worktree add` at that commit. A worktree needs
  its own `npm install`: never junction `node_modules` into one (Turbopack crashes, and
  `git worktree remove --force` follows the junction and empties the main repo's
  `node_modules`). Diff exported plans rather than trusting "same board" by eye.
- Measure performance on `next start` with `GTNH_PREWARM_ON_STARTUP=1`, after prewarm,
  not on the dev server.
