# The solver as equations

Doctrine, spoken by Jack on 2026-08-19, and the sentence this whole document
serves: **nothing from nowhere, nothing into nowhere, except where the player
put a source, a drawer, or a trash can. If it would fail in game, it fails in
the planner.**

## Current plan solver

The editor uses plan mode. On load, [`openAsPlan`](../src/lib/solver/plan/to-plan.ts)
converts older Build, Solve, and Pool plans. [`calculateThroughput`](../src/lib/solver/throughput.ts)
computes machine rates and dispatches to [`planSolve`](../src/lib/solver/plan/index.ts).
The adapter builds the solver input from the graph and turns the core result back into
card, drawer, and wire rates plus diagnostics. See [Up to](up-to.md) and
[buffer drawers](buffer-drawers.md) when working on count or drawer constraints.

## Earlier equations design

The remaining sections record the design for replacing the original iterative solver.
They explain the legacy equations and acceptance cases.

### Why a rebuild

The original solver found the answer by iteration: every machine started at
full blast and steps down to what its neighbours justify, round after round.
Iteration has one intrinsic flaw the game does not: mid-iteration, a machine
cannot tell "my neighbour is genuinely limited" from "my neighbour's number
has not finished settling." The game never faces this because chests absorb
the transients; our rounds have no chests. Every famous bug in this
codebase's history is that one flaw resurfacing - the 90% platline latch, the
balanced rings ratcheting to zero, the clog check that had to be blinded with
a dream world (and the mirror-lab hole that blinding opened), and the four
failed credit rules of 2026-08-19. Each fix taped a mechanism over the flaw;
the pile of mechanisms is the complexity, not the problem.

The problem itself is small and closed: a board's steady state is a system of
linear constraints with a preference on top. Solve it directly and there are
no rounds, no transients, nothing to latch, and no dream world - conservation
is an equation, not a goal we chase.

### Prior art: PlanNH

PlanNH (sbancuz's in-game flowchart planner) already does this, with ojAlgo
as the LP/MILP engine. What their `data/flowchart/balancer/` package settles
for us:

- **The variable families work.** One *extent* (crafts/s) per machine, one
  nonnegative *flow* per drawn edge, one nonnegative *external* per port that
  may touch the outside, and conservation rows tying them together, scaled by
  `1/max(1, qtyPerCraft)` so coefficients stay near 1.
- **Ties are broken by stages, not weights alone.** Their AUTO mode solves a
  lexicographic chain (fewest outside touchpoints, then least outside
  quantity, then least internal flow, then a canonicalization solve that
  picks one deterministic point among the remaining ties). We need our own
  stage list (below), but the shape - a chain of solves, each adding the
  previous optimum as a constraint - is the right machinery.
- **Determinism is a test, not a hope.** Single-threaded branch-and-bound,
  and a pinned test that solves the same chart twelve times and asserts the
  answers AGREE (tied optima otherwise wander). We adopt both.
- **Integer machine counts are one flag away.** Their OUTPUT/INPUT modes swap
  the continuous extent family for integer count variables (a MILP), so "how
  many machines do I build" is answered buildably, without ceiling a
  fraction. That is Jack's partial-machine-count feature; it lands as a
  planning mode after the descriptive solve ships.

Where we deliberately differ: PlanNH is a *planning* calculator - machines
floor at one, imports may appear wherever the model finds them cheapest (gated
and minimized). Ours is a *descriptive* solver of a built board: machine
counts are fixed inputs, and the outside world exists only where the player
declared it. Their machinery, our constraint set.

### The formulation, in our vocabulary

Variables (all continuous, all deterministically ordered by node/edge id):

- `act[m]` for every enabled machine: operations per second, in
  `[0, nameplate(m)]` where nameplate is the overclocked rate x machineCount
  x parallels - everything upstream of the solver (overclock.ts,
  machine-effects.ts) stays exactly as it is.
- `flow[e]` for every wire: resource per second, `>= 0`.
- `pull[s] >= 0` for every SOURCE drawer (what the plan imports there).
- `catch[d] >= 0` for every PRODUCT / BYPRODUCT drawer and trash can (what
  lands there).
- `fill[b] >= 0` for every overflow BUFFER (its net accumulation).

Constraints:

1. **Wire endpoints.** The flows into a machine port sum to exactly
   `act[m] x qtyPerCraft` (a machine at 10% eats 10% of every ingredient and
   emits 10% of every product; non-consumed inputs excluded as today).
2. **Conservation per resource per junction.** Machine production feeds its
   wires; a SOURCE feeds its wires from `pull`; a drain's wire ends in
   `catch`; a buffer's inflow equals outflow plus `fill` (and `fill = 0` when
   the buffer is STRICT - strict mode is one equals sign, it keeps its whole
   meaning).
3. **The clog, as algebra.** An output wired only to machines gets equality:
   production = what the wires carry. No catcher, no surplus - which forces
   `act` down exactly like the game's full chest. An output with a drain or
   trash keeps `>=` through its `catch` variable. This is the entire
   mirror-bound saga expressed in one constraint; there is nothing to
   propagate and no credit rule to invent, because the solver assigns the
   flows itself.
4. **Targets.** A player target rate on an output becomes a floor on the
   producing flows (feasibility reported honestly when it cannot be met -
   that is the over-asked >100% story, kept).

Objective, as a lexicographic chain (RULED by Jack, 2026-08-19: "if it would
fail in the game, it should fail in the planner" and "solve for the maximum";
implemented in `src/lib/solver/equations-core.ts`):

1. **Everything runs** (maximize total act): a fed machine with somewhere to
   put its output runs, exactly as in game. A byproduct drawer is permission
   to run, never a reason to idle; a balanced loop reads its highest
   sustainable level. (This replaced both a proposed "least machinery"
   minimization - it idled machines the game would run - and a proposed
   product-purpose stage - it starved real machines to fatten an export
   drawer. The game has no product preference; pipes round-robin.)
2. **Fairness** (progressive max-min on acts, within the locked total):
   lift the worst-off machine as high as it goes, floor the bottleneck
   there, repeat. This is the LP form of the game's round-robin item split -
   contended supply splits evenly-with-saturation, a 2000/s ask cannot crush
   a 10/s asker, and the simplex cannot hand one twin everything. Only the
   machines leaving the pool each round get floor rows, keeping the model
   linear in board size.
3. **Minimize source pulls**: recycle before importing, as a tie-break only.
4. **Ship before banking** (minimize pool fill): a buffer relays stock to
   whatever downstream will take it and banks only what nothing wants.
5. **Canonicalize** (minimize total flow): one deterministic point per board.

Alongside the stages, EQUAL-FILL rows state the game's round-robin as hard
physics: machine co-consumers of one output port fill at the same per-pull
rate (a sibling's share of its pull never exceeds a clean co-consumer's act;
consumers the diagnosis marks output-throttled, power-stalled or bare-ported
are exempt). This is what makes a TAPPED break-even ring die instead of
pretending its tap never pulls - the LP contains that fantasy point, and
these rows exclude it. Power stalls are pinned to act 0 inside the LP so the
outage propagates by conservation. Stage locks clamp provably-signed
objectives and re-cut with wider slack if a later stage reports infeasible,
because locks built from solver dust once poisoned whole boards.

Settled alongside (same ruling): an overspilling drawer is an OUTPUT - GTNH
drawers void their overflow, so a producer behind a plain buffer drawer runs
full and the drawer banks the surplus; `bufferMode: "strict"` is the player's
opt-out that pins the fill at zero and surfaces the imbalance on the machine.
Targets are floors a maximizing board usually clears anyway, kept only for
compatibility with the existing dial.

### Proposed role for the iterative solver

Not deleted - demoted to the diagnosis layer, which is what players love it
for and what it is actually good at: capable/could-run figures, "one wire
fixes it," dead-loop stories. The equations own the BOOKS (act, flows,
drawers, boundary lists); the verdict layer never touches a book again. The
two-layer split shipped in v2.16.3-v2.18.x already draws this line; the
equations replace the settlement side of it.

Longer term, the diagnosis figures themselves can become what-if solves
(relax one constraint, re-solve, report the delta), at which point the
iterative machinery retires entirely. Not required for shipping.

### Engine

Prototype: a small dense simplex written in TS (boards are tiny - hundreds of
variables), Bland's rule for cycling safety, PlanNH-style row scaling,
staged solves by re-solving with the previous stage's optimum as a
constraint. If numerics bite on real boards, swap the engine for a WASM LP
(HiGHS or GLPK) behind the same model-builder interface - the model builder,
not the engine, is the asset. Integer counts (the planning mode) will need
the WASM engine or a tiny branch-and-bound; decide when we get there.

### Migration plan

1. **The truth machine first**: a tick simulator (virtual machines, finite
   virtual chests, run until rates settle) as a TEST ORACLE. It answers
   "what does the game literally do" for any fixture, so correctness stops
   being hand-derived at 4am. Simulator disagreements with the equations are
   settled by doctrine, in writing.
2. **Offline prototype**: `tools/solver-lab/` script, not wired to the app.
   Run against every pinned fixture, the mirror-lab board, the three player
   boards from the 2026-08-18 storm, and all ~140 public community plans
   (downloadable via the API). Human-read every diff against the current
   solver.
3. **Swap the books** behind the existing `ThroughputResult` shape - the UI
   does not change. The full pinned suite plus the corpus diff is the gate.
4. **Then the new dimension**: count-space planning mode (fractional/integer
   machine counts, "what do I build for X/s"), which this foundation makes
   nearly free.

### Acceptance matrix (every entry hand-verified or simulator-verified)

| Board | Expected |
| --- | --- |
| mirror-lab (Downloads/mirror-lab.json) | Refinery 10%, Packer 10%, no vanished Xium |
| Digimen titanium line, unsourced | all 0% (lye deficit), clogs named |
| Digimen + NaOH source | core alive (~slag-bound), EBF ~100% |
| bob's "with buffers" 5971863c | slurry core 0 as wired (Na2CO3/AlOH dead end) unless drawers added |
| silicone distillation | LCR exactly 1/18, electrolyzer 100% |
| pa-cell loop, all four wirings | electrolyzer 100%, canners 17.78/23.70/5.93% |
| platline | the ammonia ceiling, never 90% of it |
| deficit loop (conservation.test) | hard zero, quiet wires |
| tour biodiesel board | 100/83/42 with the carbon drawer |
