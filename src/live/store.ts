import type { LivePlan } from "@/lib/live/ops";
import type { LiveMember } from "@/lib/live/protocol";
import { designRole, listMembers, usernamesFor, type DesignRole } from "@/lib/server/cloud-plans";
import { getCommunityDb, loadSessionUser } from "@/lib/server/community";

/**
 * The live service's reads and writes, all through the server's Supabase
 * client (fetchWithDbTimeout, or the local database with LOCAL_DB=1). Never a
 * write per edit: a room writes when it opens (the lease), every 30 s (the
 * lease again), and when it flushes (at most every 8 s while edited).
 *
 * A lease is a token as well as a time: taking one writes a fresh random
 * token, and every later renewal, flush and release is conditional on it. A
 * room whose lease is no longer its own (another took it, or it lapsed and a
 * REST save cleared it) hears "lost" and stops writing.
 */

/** How a write conditional on the lease went. */
export type LeaseOutcome =
  /** Written: the lease is still this room's. */
  | "held"
  /** The design is missing or deleted. */
  | "gone"
  /** The design is there, but its lease is no longer this room's. */
  | "lost";

export interface PlanStore {
  /** The account behind a verified session, or undefined when it is gone; throws when the database does not answer. */
  account(userId: string): Promise<{ id: string; username: string } | undefined>;
  /** What the account may do with the design: "owner", "editor" or null. */
  role(userId: string, ownerId: string, designId: string): Promise<DesignRole | null>;
  /**
   * Takes the lease with `token` whoever held it (one live service per
   * database) and reads the plan. Undefined when the design is missing or deleted.
   */
  lease(
    ownerId: string,
    designId: string,
    token: string,
    until: Date,
  ): Promise<{ plan: LivePlan; seq: number } | undefined>;
  /** Extends the lease, while it is `token`'s. */
  renew(ownerId: string, designId: string, token: string, until: Date): Promise<LeaseOutcome>;
  /**
   * Writes the plan and its seq while the lease is `token`'s, extending it
   * (or ending it: `until` null).
   */
  flush(
    ownerId: string,
    designId: string,
    token: string,
    plan: LivePlan,
    seq: number,
    until: Date | null,
  ): Promise<LeaseOutcome>;
  /** Ends the lease without writing the plan, when it is still `token`'s. */
  release(ownerId: string, designId: string, token: string): Promise<void>;
  /** The accounts the design is shared with. */
  members(ownerId: string, designId: string): Promise<LiveMember[]>;
  usernames(ids: string[]): Promise<Map<string, string>>;
}

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? "no answer"}`);
}

export function supabasePlanStore(): PlanStore {
  const db = () => getCommunityDb();

  /** A conditional write matched nothing: the design went, or the lease is someone else's. */
  async function missed(ownerId: string, designId: string): Promise<LeaseOutcome> {
    const { data, error } = await db()
      .from("library_designs")
      .select("deleted_at")
      .eq("user_id", ownerId)
      .eq("id", designId)
      .maybeSingle();
    if (error) {
      fail("Reading the lease failed", error);
    }
    const row = data as { deleted_at: string | null } | null;
    return !row || row.deleted_at ? "gone" : "lost";
  }

  return {
    async account(userId) {
      const user = await loadSessionUser(userId);
      return user ? { id: user.id, username: user.username } : undefined;
    },
    role: (userId, ownerId, designId) => designRole(db(), userId, ownerId, designId),
    async lease(ownerId, designId, token, until) {
      const { data, error } = await db()
        .from("library_designs")
        .update({ live_lease_until: until.toISOString(), live_lease_token: token })
        .eq("user_id", ownerId)
        .eq("id", designId)
        .is("deleted_at", null)
        .select("plan,seq")
        .maybeSingle();
      if (error) {
        fail("Taking the lease failed", error);
      }
      if (!data) {
        return undefined;
      }
      const row = data as { plan: LivePlan; seq: number | string | null };
      return { plan: row.plan ?? {}, seq: Number(row.seq ?? 0) };
    },
    async renew(ownerId, designId, token, until) {
      const { data, error } = await db()
        .from("library_designs")
        .update({ live_lease_until: until.toISOString() })
        .eq("user_id", ownerId)
        .eq("id", designId)
        .eq("live_lease_token", token)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();
      if (error) {
        fail("Renewing the lease failed", error);
      }
      return data ? "held" : missed(ownerId, designId);
    },
    async flush(ownerId, designId, token, plan, seq, until) {
      const now = new Date().toISOString();
      const { data, error } = await db()
        .from("library_designs")
        .update({
          plan,
          seq,
          plan_updated_at: now,
          updated_at: now,
          live_lease_until: until ? until.toISOString() : null,
          live_lease_token: until ? token : null,
        })
        .eq("user_id", ownerId)
        .eq("id", designId)
        .eq("live_lease_token", token)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();
      if (error) {
        fail("Saving the plan failed", error);
      }
      return data ? "held" : missed(ownerId, designId);
    },
    async release(ownerId, designId, token) {
      const { error } = await db()
        .from("library_designs")
        .update({ live_lease_until: null, live_lease_token: null })
        .eq("user_id", ownerId)
        .eq("id", designId)
        .eq("live_lease_token", token);
      if (error) {
        fail("Releasing the lease failed", error);
      }
    },
    members: (ownerId, designId) => listMembers(db(), ownerId, designId),
    usernames: (ids) => usernamesFor(db(), ids),
  };
}
