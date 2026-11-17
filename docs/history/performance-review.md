# GTNH Factory Flow performance review

This report consolidates the performance audit and Git history investigation of the October 20, 2026 checkout at `47d692d5` (`fix: restore card sharpness after zooming`). Source references and measurements are for that revision. The current checkout has since changed; this report does not re-audit current `main` or establish what is deployed.

**Nine findings: three originated in the October UI and solver rework, and six predate it.** The rework broadened when some older costs occur. The recent database hotfixes and the zoom-sharpness fix did not introduce any of the nine.

## Findings

### 1. P1: Community plan solves block the server request thread

Uploads, plan updates, and stale-stat refreshes calculate throughput synchronously. A preview of a plan with stale stats waits for its solve, and unrelated requests in the same process can wait behind it. With HiGHS loaded, a real 49-machine platinum-line fixture took **871 ms after warm-up** and delayed a queued event-loop callback by the same amount. A separate first run took about 1.8 seconds. This measures the solver core, without HTTP or database time.

**History:** Upload stats date to `94815769` (July 26); refresh on view arrived in `6fcfde24` (August 19). The rework added HiGHS for plan-mode stats in `277a2ca6`, and `3abcc8df` began converting legacy uploads to plan mode before calculating stats. The synchronous architecture predates the rework; the workload changed.

**Fix:** Move stats calculations into a bounded server worker pool. Coalesce duplicate refreshes of the same plan/version and consider serving stored stats while refreshing them off the request path. Verify stats parity and the latency of concurrent lightweight requests.

**Source:** `src/app/api/community/plans/[planId]/route.ts:93,143,281`; `src/app/api/community/plans/route.ts:308`.

### 2. P1: Background drawing leaves more than 150 cards mounted

The virtualizer limits newly wanted cards to the nearest 150. Background measurement can mount other cards, and the larger keep rectangle can retain them indefinitely. A 400-card fixture settled with **360 mounted cards** and no pins, export holds, or undrawn cards remaining.

**History:** The identical reproduction returned **360/150** on the initial card-shell implementation (`4faae0b0`), the follow-up that hid far cards (`82eaac30`), and the audited tip. The issue was present when card shells were introduced on October 14.

**Fix:** Separate temporary measurement mounts from camera retention. Enforce the budget after measurement, with bounded hysteresis and explicit exceptions for pins and export. Verify that unmounted cards retain correct handle positions and routes.

**Source:** `src/components/flow/virtual/card-virtualizer.ts:494,533,544`.

### 3. P1: Each mounted card scans every wire to build verdicts and ports

`deriveNodeVerdict` and `buildRailPorts` each filter the full edge array twice for one card's incoming and outgoing wires. With 150 cards and 999 wires, one pass visited **599,400 edges** and took about **148 ms** in the instrumented probe, excluding React and DOM work.

**History:** Both scans date to `6e150412` (August 2), the earlier verdict-strip and port-rail redesign. The October clean card reused both functions from its first implementation in `6c658c41`.

**Fix:** Share incoming/outgoing indexes across verdict and rail calculations and reuse the related node, recipe, and drawer lookups. Preserve port matching for shared-machine sections and legacy handles.

**Source:** `src/components/flow/node-verdict.ts:879,1794`; `src/components/flow/clean/clean-model.ts:942`.

### 4. P1: Worker replies invalidate unchanged card data

A worker reply supplies fresh result objects, and the sink replaces `lastResult` wholesale. The node-data cache compares each card's result by reference. A cloned result for **1,000 cards with zero value changes** produced 1,000 new node-data objects. That measures identity invalidation; it does not count DOM updates.

**History:** Whole-result replacement came with background solving in `3285e85f` (August 26). The rework's `277a2ca6` sends all plan-mode solves through the worker when available, including small plans.

**Fix:** Preserve unchanged per-card and per-drawer results on arrival, or transfer result deltas. Subscribe explicitly to the plan extras that affect each card so reusing a result cannot leave a stale display.

**Source:** `src/store/factory-store.ts:6772`; `src/components/flow/FactoryFlow.tsx:2150`; `src/components/flow/edge-detail.ts`.

### 5. P2: Editing one card revalidates every edge on the main thread

`updateNode` invokes global edge pruning. Validation repeatedly searches nodes, recipes, and drawers for endpoints before the worker runs. A synthetic 1,000-card chain took **25 ms with wires versus 6 ms without wires** for the synchronous update. The 4,000-card chain took **153 ms**. Actual worker solving was excluded.

**History:** Whole-plan pruning on card edits dates to `49473711` (May 21). Shared-machine sections changed endpoint resolution in `204d31f0` without removing the global pass.

**Fix:** Skip validation when the edit cannot change connection compatibility. For local edits that can change it, validate incident edges with shared lookups and retain orphan cleanup. Keep global validation for migrations and bulk changes that can affect arbitrary edges.

**Source:** `src/store/factory-store.ts:1816,5858`.

### 6. P2: Hovering an overview resource rebuilds the edge model

Entering and leaving a resource row changes `activeFlowResourceKey`, invalidating the main edge memo. Flow ranking, endpoint offsets, bundles, channel grouping, object comparisons, and sorting run again. This is a rebuild of the model; the audit did not show that the router recalculates wire paths on hover.

**History:** The highlight dependency dates to `4920c23c` (May 22). The clean overview still writes the same hover state. The rework deferred project and result inputs for edge calculations in `42f39337`, but retained the hover dependency.

**Fix:** Apply highlighting separately from edge model construction using an indexed resource-to-edge lookup and a narrow subscription or paint layer. Profile both entering and leaving a row.

**Source:** `src/components/flow/FactoryFlow.tsx:2966,3397`; `src/components/flow/clean/rail/OverviewRail.tsx:596`.

### 7. P2: The island cache thrashes above 64 independent islands

Islands are looked up and inserted sequentially into a 64-entry LRU. With 65 islands traversed in the same order, earlier misses evict later retained answers before their lookup. Repeating unchanged input directly at the island solver produced **zero hits and 65 misses**. The full-project cache can still handle exact repeats before they reach this layer.

**History:** `e24a73d5` (October 14) introduced the capacity and lookup order together. This limits the new cache's benefit; it does not establish that the previous solver was faster.

**Fix:** Look up retained islands before inserting misses, or reserve a bounded cache for the active plan. Verify reuse after a one-island edit on a board with more than 64 islands, and check answer parity.

**Source:** `src/lib/solver/plan/adapter/engine.ts:18`; `src/lib/solver/plan/solve-plan.ts:62`.

### 8. P2: Wire waypoints trigger throughput solves

`updateEdge` always calls `solveBooks`. The worker cache serializes the full plan except `view`. Waypoint-only and timestamp-only changes each caused a cache miss when passed to the solver entry point. Waypoints change the shape of a wire without changing its material flow.

**History:** The generic edge update already solved in `de7c6ef6` (May 22). `01550f5d` (August 5) added waypoint edits, and `3285e85f` (August 26) introduced the broad books cache key.

**Fix:** Separate route edits from solver edits and key the books on fields that affect the returned results. Verify that waypoint edits still reroute, persist, and undo, and that material and rate changes still invalidate the books.

**Source:** `src/store/factory-store.ts:4703`; `src/store/solve-books.ts:145`.

### 9. P2: Group summaries repeatedly traverse the whole plan

The board computes summaries synchronously for every group. Each group scans machine entries and materializes the entire result-node array again; descendant discovery also repeatedly scans the pocket list.

**History:** This was present in the first group-summary implementation, `573c24f4` (October 14). Later Up to changes modified the displayed math without introducing those scans.

**Fix:** Aggregate direct members once, then merge totals up the group tree. Reuse machine-list calculations and compute full summary details only where needed. Verify nested groups and the ordering of tied flows.

**Source:** `src/components/flow/clean/group/group-summary.ts:43,74,78,106`; `src/components/flow/FactoryFlow.tsx:2043`.

## Hotfix assessment

| Change | What the history shows |
| --- | --- |
| 4.3.1–4.3.3 database fixes | None introduced the nine mechanisms above. In particular, `32fb4c01` reduced polling frequency and cached account lookups. Request-thread solving is a separate source of server latency. |
| `3f2d9f31`: always recalculate | Removed the manual-solve bypass because plan boards had no control to turn it back on. This exposed existing solve costs to browsers that had opted out. Automatic solving was already the default. |
| `47d692d5`: zoom sharpness | Changed compositor retention and final-scale rasterization. It did not introduce any of the nine. Its separate effect on zoom frame time needs a browser A/B comparison. |

## Recommended fix order

1. **Board responsiveness:** Fix the mount budget first, then preserve unchanged result identities and share graph indexes. Excess mounts multiply the cost of broad renders. Compare identical exported plans before and after in headless Playwright on production builds after prewarm.
2. **Server responsiveness:** Isolate community stats solves independently of the board work. Measure event-loop delay and concurrent request latency with a cold and warm solver, and verify stats parity.
3. **Remaining edit and hover costs:** Narrow edge validation, separate hover painting from edge construction, skip solves on waypoint edits, fix island cache eviction, and aggregate group summaries.

## Validation and limits

Typecheck and all eight targeted diagnostics passed in the original audit. The historical virtualization comparison passed separately. Local harnesses are under the gitignored `scratch/probes/` directory: `performance-audit.test.ts` and `performance-audit.config.ts`.

The timings are local Node/Vitest measurements, not production latency or browser frame times. The history establishes the origin of each mechanism; overall old-versus-new performance still needs identical-plan browser profiles. No application source was changed.

## Implementation on the performance branch

| Finding | Change |
| --- | --- |
| 1. Community stats | A bounded Node worker pool calculates stats for new posts, edits, and refreshes. Refreshes share a pending solve for the same saved revision. A refresh writes its stats only if the saved revision still matches. |
| 2. Card mounts | The keep rectangle uses spare camera slots. Background measurement has its own batch limit and releases extra cards after drawing them. Pins and export holds retain their exceptions. |
| 3. Card verdicts and ports | Verdicts and port rails share indexed edges, outlet counts, and recipe and drawer lookups. |
| 4. Worker replies | Unchanged results and diagnostics keep their object identities. Cards subscribe to the diagnostics they need to stay current. |
| 5. Card edits | Changes that preserve port compatibility skip wire validation. Changes to recipes and recipe input overrides validate the affected card's wires using indexed endpoints. |
| 6. Resource hover | Resource highlights update through narrow card and wire subscriptions. Hover leaves the board models and routed geometry intact. |
| 7. Islands | The solver looks up every existing island result before adding misses. A regression test keeps 64 hits on the 65-island reproduction. |
| 8. Waypoints | Waypoint edits keep current throughput books. The worker cache ignores waypoints and save stamps. |
| 9. Group summaries | Direct members are aggregated once and merged up the group tree. Expanded groups only need machine counts for the frame. |

On a local 84-card fixture, the synchronous stats calculation delayed a concurrent lightweight request by 513 ms.
The request took 18 ms while a cold worker calculated the stats and 4 ms with a warm worker. All three runs
returned identical stats. These measurements use a local HTTP harness around the stats code.

The production browser comparison against `859e934a` used the same 400-card plan, camera, and zoom. The settled
mount count fell from 400 to 149 after every card had been measured. Across 30 hover transitions, Chromium reported
293 ms of script time before and 164 ms after. The wire still lit and its path stayed fixed. Frame-time p95 rose
from 250 ms to 333 ms in that run. The browser fixtures supplied their own recipes because the local dataset
manifest was missing.

In local Node probes, verdict and rail work for 150 cards on a 1,000-card chain fell from 73.2 ms to 5.5 ms
at the median. The 4,000-card single edit fell from 114.0 ms to 23.0 ms before worker work. The 1,000-card,
200-group summary probe fell from 107.7 ms to 71.0 ms. These timings measure the named code paths.
