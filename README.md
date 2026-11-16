# GTNH Factory Flow

A production-chain planner for GregTech: New Horizons. Hosted URL pending.

Search the real GTNH recipe set, place recipes as machine cards on a board, wire outputs
to inputs, and the solver works out rates, machine counts, power, bottlenecks and
surplus for the whole plan. On a plan board, you can set machine counts and target rates
or let the solver size a line. Plans save in the browser, share as links, and can be posted
to the community hub.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck
npm run test
```

The app needs a recipe dataset. To proxy a hosted dataset, replace the example URL with
your dataset backend's URL.

```bash
GTNH_DATASET_BACKEND_URL=https://datasets.example.com npm run dev
```

For local data, place a dataset and its `datasets.manifest.json` under `public/datasets/gtnh/`
(ignored by git). Community features need Supabase. See [docs/community.md](docs/community.md).

## How it fits together

- `tools/dataset-pipeline/`: a Forge mod runs inside a real GTNH client and exports every
  recipe, NEI layout, machine and rendered icon; Node scripts normalize it into the
  dataset the app reads. Recipe data never comes from wikis or hand-written tables.
- `src/lib/`: the domain model, machine math (overclocks, parallels, curated per-machine
  behaviour checked against the mod source) and an LP-based solver.
- `src/components/`, `src/store/`: the Next.js + React Flow UI and Zustand stores.

Start with [AGENTS.md](AGENTS.md) for contributor and agent instructions. Use the
[documentation index](docs/README.md) when you need a guide or technical reference.

## License and credits

Code is MIT licensed. GTNH, Minecraft, mod assets, generated datasets and icons are not
included and remain under their owners' licenses.

This repository is a fork of
[jackwrichards/gtnh-factory-flow](https://github.com/jackwrichards/gtnh-factory-flow),
which was forked from the original
[Samiracle64/gtnh-factory-flow](https://github.com/Samiracle64/gtnh-factory-flow).
The original work is MIT licensed and its copyright is retained in `LICENSE`.
