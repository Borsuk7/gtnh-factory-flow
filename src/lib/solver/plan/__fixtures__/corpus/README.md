# Solver corpus

Copied from the mod (`src/test/resources/solver-corpus/`, solver as of phase 7, re-recorded 2026-10-13) plus 16 inputs
dumped for the gtnh-flow charts. The [loader](../load.ts) and [digest](../digest.ts)
define the input and golden formats used in this checkout.

- `inputs/<name>.json` (31): a `SolveInput` as the mod's `SolveInputJson.write` writes it. Arrays keep
  index order (ids are in Java signed UUID order, see `compareId` in `../load.ts`), `chance` is a Java float's shortest
  decimal (the loader applies `Math.fround`), `targetOutputRates`/`targetInputRates` keys are port indices as strings,
  `properties` is not written. 14 plans from the game (`single-card-v2` ... `platline`) and 16 charts (`gtnh-flow-<chart>`),
  the charts being the ones that carry target rates, `number:` pins and real alternatives.
- `goldens/<case>.json` (33): the digest of a whole `Answer.Solved`, `{ solution, alternatives }`. The 30 inputs'
  cases plus `platline-x4` and `platline-x10`, whose inputs are not stored: `load.ts` builds them with `tile(platline, k)`
  (ids of copy c >= 1 are `nameUUIDFromBytes("c:id")`; verified against the goldens' ids in `harness.test.ts`).
  Numbers print as Java doubles (`0.0`), maps have lexicographically sorted keys, ports are `{nodeId, portIndex, input}`
  (not the TS `{node, port, input}`; `../digest.ts` converts an `Answer`), enums by name.
  The `platline-x10` golden has no `solution.unneeded` key (recorded before the field existed); the harness drops it
  from the solver's digest for that case. That case runs only with `CORPUS_BENCH=1`.
- Comparison: `../compare.ts`: same keys, same array lengths and order, numbers equal iff
  `p == q || |p - q| <= 1e-6 * max(1, |p|, |q|)`.

The 16 chart dumps were produced by a local Java test (`ChartDumpTest`) using
`com.gtnhplanner.harness.GtnhFlowLoader`.
- `buffer-drawers` (2026-10-14): a case built in the mod's `BufferDrawerTest` (not from the game) for buffer drawers
  (`docs/buffer-drawers.md`): an exact buffer, one whose rule its pins cannot keep (the drawer relaxation), an at-most one
  beside a plain wire. The same golden passes in both suites. Every golden gained `solution.drawers.ports: {}` then.
