# Plan networks

Networks are personal resource ledgers over saved plans. They never change a plan's solve or settings. Create or open
them from the tab strip's + menu or the library's Networks section. Plans keep their normal library collections.

## Accounting

A plan contributes its solved boundary imports and exports, through drawers or directly through machine ports.
Collected products, byproducts and buffer surplus count as supply; trash and internal machine flow are excluded.
Removing a boundary drawer does not remove the machine's solved flow from the network. Importing and exporting
the same resource contributes to both columns. Item and fluid identities stay separate; there is no inferred
conversion or matching by name.

Each plan's I/O button selects network inputs and outputs per machine. All ports count by default. Clear all starts
an explicit selection; Use all ports also includes ports added later. Selections follow stable machine/recipe-section
port ids across drawer removal and network moves. An unavailable selected port marks totals incomplete. Internal
wires contribute no boundary flow, even when selected. Shared buffer surplus and drawer chains have separate Drawers
entries because their net rates cannot be assigned to a single machine port. Power always covers the included plan.
These choices only filter the ledger; they never change recipes, rates, or the solve.

At each network, supply minus demand gives free resources or a shortage. These are configured rates, not measured
inventories or a promise that supplying lines can operate without their own missing inputs. Power generation and
usage use the same average figures as the plan overview and sum included descendants once.

Subnetworks balance locally first. Internal (the default) exposes nothing; Import exposes residual demand; Export
exposes residual supply; Both exposes either. Every ancestor boundary needs its own permission. Parent totals only see
these boundary rates, never the child's gross internal production. From parent is a request. When a parent is short,
the view flags that resource without allocating available supply among competing plans or subnetworks.

Each plan has one direct membership across the account hierarchy. Moving replaces its old membership. Inclusion
can be disabled without removing members. Deleting a network releases its plans and promotes its children, keeping
their sharing settings. Shared references include owner and design ids; losing access leaves an unavailable member
and incomplete totals. Deleting an owned plan removes its membership. Task boards do not contribute.

## Storage and calculations

`src/lib/networks/model.ts` owns topology validation and aggregation. The catalogue is separate from FactoryProject,
so ordinary exports, links and live operations remain unchanged. The `gtnh-plan-networks` IndexedDB database stores
account catalogues and conflict recovery copies. Browser-tab writes compare a token in one read/write transaction.

Authenticated GET/PUT `/api/library/networks` saves the whole topology under an account revision. PUT compares that
revision atomically, including creation races. Empty catalogues remain revisioned so an old device cannot resurrect a
deletion. Rejected writes retain the local candidate until the player chooses a version. Calculated results do not sync.

Apply `supabase/migrations/2026-10-19-plan-networks.sql` when provisioning the server database. Local development
loads it automatically. Networks work locally while signed out; signing in adopts this browser's initial catalogue
when that account has no local catalogue yet. A conflicting existing remote catalogue requires a choice.

Closed members are normalized and have recipes restored through the same pure helper as the canvas. They solve in a
separate sequential worker queue and never land on the canvas or write back to saved plans. A bounded content cache
includes plan contents and dataset dependencies. Current canvas results can be reused. Missing data and failed or
outdated results are explicit; partial totals are marked incomplete. Display dials only reformat figures.

Tests: `src/lib/networks/*.test.ts`, `src/app/api/library/networks/route.test.ts`, and tab/library tests. Real-app checks
cover closed members, contribution rows, toggles, moves, parent sharing, reload, account sync and compact layout.
