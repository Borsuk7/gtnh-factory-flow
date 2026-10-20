import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { forgetSessionUsers, getCommunityDb, makeSessionToken, resetDbBreaker } from "@/lib/server/community";
import { resetMemoryTokens } from "@/lib/server/memory-rate";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import * as library from "./route";
import * as design from "./designs/[designId]/route";
import * as members from "./designs/[designId]/members/route";
import * as member from "./designs/[designId]/members/[userId]/route";
import * as search from "../accounts/search/route";
import * as meRoute from "../community/auth/me/route";

/**
 * Cloud plans over REST, against the local database: sharing a design with
 * other accounts, members reading and saving it, leaving, the live lease
 * refusing plan bodies, deletes dropping members, account search, and the
 * notices the live service is sent.
 */

let local: LocalDatabase;
let notices: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
let noticeServer: Server;
const users: Record<string, { id: string; cookie: string }> = {};

async function makeUser(username: string) {
  const { data, error } = await getCommunityDb()
    .from("community_users")
    .insert({ username, password_hash: "x:y" })
    .select("id")
    .single();
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  users[username] = { id, cookie: `gtnh_session=${makeSessionToken(id)}` };
}

function request(method: string, path: string, who?: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(who ? { cookie: users[who]!.cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

function plan(name: string) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: `plan-${name}`,
    name,
    recipes: [],
    nodes: [],
    storages: [],
    edges: [],
    fuelProfiles: [],
    tasks: [{ id: "t1", title: name, status: "todo", order: "a0" }],
  };
}

function upsertBody(name: string, stamp: string, withPlan = true) {
  return {
    name,
    icon: null,
    folderId: "folder-mine",
    closed: false,
    favorite: true,
    order: 3,
    communityPlanId: null,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: stamp,
    planUpdatedAt: stamp,
    ...(withPlan ? { plan: plan(name) } : {}),
  };
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "cloud-plans-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
  noticeServer = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      notices.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(text),
      });
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((resolve) => noticeServer.listen(0, "127.0.0.1", resolve));
  vi.stubEnv(
    "LIVE_INTERNAL_URL",
    `http://127.0.0.1:${(noticeServer.address() as AddressInfo).port}`,
  );
  vi.stubEnv("LIVE_INTERNAL_TOKEN", "internal-secret");
  for (const name of ["ann", "bob", "carol", "bobby_b", "dan"]) {
    await makeUser(name);
  }
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  noticeServer?.close();
  await local?.close();
  vi.unstubAllEnvs();
});

describe("cloud plans over REST", () => {
  const designId = "design-shared-1";

  it("shares a plan: the owner adds a member, both libraries show it, the live service hears", async () => {
    const saved = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "ann",
        upsertBody("Steel", "2026-10-14T11:00:00.000Z"),
      ),
      params({ designId }),
    );
    expect(saved.status).toBe(200);

    notices = [];
    const shared = await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.bob!.id}`, "ann"),
      params({ designId, userId: users.bob!.id }),
    );
    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual({ members: [{ id: users.bob!.id, username: "bob" }] });
    expect(notices).toEqual([
      {
        path: "/internal/members",
        auth: "Bearer internal-secret",
        body: {
          doc: `${users.ann!.id}:${designId}`,
          members: [{ id: users.bob!.id, username: "bob" }],
          added: [users.bob!.id],
          owner: { id: users.ann!.id, username: "ann" },
          name: "Steel",
        },
      },
    ]);

    const annLibrary = await (await library.GET(request("GET", "/api/library", "ann"))).json();
    expect(annLibrary.designs.find((d: { id: string }) => d.id === designId).members).toEqual([
      { id: users.bob!.id, username: "bob" },
    ]);
    expect(annLibrary.shared).toEqual([]);

    const bobLibrary = await (await library.GET(request("GET", "/api/library", "bob"))).json();
    expect(bobLibrary.designs).toEqual([]);
    expect(bobLibrary.shared).toEqual([
      expect.objectContaining({
        ownerId: users.ann!.id,
        ownerName: "ann",
        id: designId,
        name: "Steel",
        members: [{ id: users.bob!.id, username: "bob" }],
      }),
    ]);
  });

  it("lets the owner and members read the plan, and nobody else", async () => {
    const asBob = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "bob"),
      params({ designId }),
    );
    expect(asBob.status).toBe(200);
    const read = await asBob.json();
    expect(read).toMatchObject({ role: "editor", ownerId: users.ann!.id, seq: 0, live: false });
    expect(read.plan.tasks[0].title).toBe("Steel");

    const asAnn = await design.GET(
      request("GET", `/api/library/designs/${designId}`, "ann"),
      params({ designId }),
    );
    expect((await asAnn.json()).role).toBe("owner");

    const asCarol = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "carol"),
      params({ designId }),
    );
    expect(asCarol.status).toBe(404);
    const bobsOwn = await design.GET(
      request("GET", `/api/library/designs/${designId}`, "bob"),
      params({ designId }),
    );
    expect(bobsOwn.status).toBe(404);
    const badOwner = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=nope`, "bob"),
      params({ designId }),
    );
    expect(badOwner.status).toBe(400);

    const list = await members.GET(
      request("GET", `/api/library/designs/${designId}/members?owner=${users.ann!.id}`, "bob"),
      params({ designId }),
    );
    expect(await list.json()).toEqual({
      ownerId: users.ann!.id,
      ownerName: "ann",
      role: "editor",
      members: [{ id: users.bob!.id, username: "bob" }],
    });
  });

  it("lets a member save the plan and its name, leaving the owner's folders and stars alone", async () => {
    const saved = await design.PUT(
      request("PUT", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "bob", {
        ...upsertBody("Steel by Bob", "2026-10-14T12:00:00.000Z"),
        folderId: "folder-bob",
        favorite: false,
      }),
      params({ designId }),
    );
    expect(saved.status).toBe(200);
    const { data } = await getCommunityDb()
      .from("library_designs")
      .select("name,folder_id,favorite,sort_order,plan")
      .eq("user_id", users.ann!.id)
      .eq("id", designId)
      .single();
    expect(data).toMatchObject({
      name: "Steel by Bob",
      folder_id: "folder-mine",
      favorite: true,
      sort_order: 3,
    });
    expect((data as { plan: { name: string } }).plan.name).toBe("Steel by Bob");

    const stranger = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}?owner=${users.ann!.id}`,
        "carol",
        upsertBody("Mine now", "2026-10-14T12:30:00.000Z"),
      ),
      params({ designId }),
    );
    expect(stranger.status).toBe(404);
  });

  it("refuses a plan body while the live service holds the lease, and still takes metadata", async () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    await getCommunityDb()
      .from("library_designs")
      .update({ live_lease_until: until })
      .eq("user_id", users.ann!.id)
      .eq("id", designId);
    const withPlan = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "ann",
        upsertBody("Steel", "2026-10-14T13:00:00.000Z"),
      ),
      params({ designId }),
    );
    expect(withPlan.status).toBe(409);
    expect(await withPlan.json()).toMatchObject({ live: true });
    const metaOnly = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "ann",
        upsertBody("Steel renamed", "2026-10-14T13:00:00.000Z", false),
      ),
      params({ designId }),
    );
    expect(metaOnly.status).toBe(200);
    expect((await metaOnly.json()).design.name).toBe("Steel renamed");
    const read = await design.GET(
      request("GET", `/api/library/designs/${designId}`, "ann"),
      params({ designId }),
    );
    expect((await read.json()).live).toBe(true);
    await getCommunityDb()
      .from("library_designs")
      .update({ live_lease_until: null })
      .eq("user_id", users.ann!.id)
      .eq("id", designId);
  });

  it("lets only the owner share, and a member leave", async () => {
    const bobShares = await member.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}/members/${users.carol!.id}?owner=${users.ann!.id}`,
        "bob",
      ),
      params({ designId, userId: users.carol!.id }),
    );
    expect(bobShares.status).toBe(403);
    await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.carol!.id}`, "ann"),
      params({ designId, userId: users.carol!.id }),
    );
    const bobRemovesCarol = await member.DELETE(
      request(
        "DELETE",
        `/api/library/designs/${designId}/members/${users.carol!.id}?owner=${users.ann!.id}`,
        "bob",
      ),
      params({ designId, userId: users.carol!.id }),
    );
    expect(bobRemovesCarol.status).toBe(403);
    const self = await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.ann!.id}`, "ann"),
      params({ designId, userId: users.ann!.id }),
    );
    expect(self.status).toBe(400);

    notices = [];
    const bobLeaves = await member.DELETE(
      request(
        "DELETE",
        `/api/library/designs/${designId}/members/${users.bob!.id}?owner=${users.ann!.id}`,
        "bob",
      ),
      params({ designId, userId: users.bob!.id }),
    );
    expect(bobLeaves.status).toBe(200);
    expect(await bobLeaves.json()).toEqual({
      members: [{ id: users.carol!.id, username: "carol" }],
    });
    expect(notices.map((notice) => notice.path)).toEqual(["/internal/members"]);
    const gone = await design.GET(
      request("GET", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "bob"),
      params({ designId }),
    );
    expect(gone.status).toBe(404);
  });

  it("deletes for the owner only, dropping every member and telling the live service", async () => {
    const byCarol = await design.DELETE(
      request("DELETE", `/api/library/designs/${designId}?owner=${users.ann!.id}`, "carol"),
      params({ designId }),
    );
    expect(byCarol.status).toBe(403);

    notices = [];
    const byAnn = await design.DELETE(
      request("DELETE", `/api/library/designs/${designId}`, "ann"),
      params({ designId }),
    );
    expect(byAnn.status).toBe(200);
    expect(notices).toEqual([
      {
        path: "/internal/deleted",
        auth: "Bearer internal-secret",
        body: { doc: `${users.ann!.id}:${designId}` },
      },
    ]);
    const carolLibrary = await (await library.GET(request("GET", "/api/library", "carol"))).json();
    expect(carolLibrary.shared).toEqual([]);
    // The owner's list keeps the tombstone, so the id is never reused.
    const annLibrary = await (await library.GET(request("GET", "/api/library", "ann"))).json();
    expect(
      annLibrary.designs.find((d: { id: string }) => d.id === designId).deletedAt,
    ).not.toBeNull();
  });

  it("finds accounts by username prefix, leaving the caller out", async () => {
    resetMemoryTokens();
    const find = async (q: string, who = "bob") =>
      search.GET(request("GET", `/api/accounts/search?q=${encodeURIComponent(q)}`, who));
    expect(await (await find("BO", "ann")).json()).toEqual({
      accounts: [
        { id: users.bob!.id, username: "bob" },
        { id: users.bobby_b!.id, username: "bobby_b" },
      ],
    });
    expect((await (await find("bo")).json()).accounts).toEqual([
      { id: users.bobby_b!.id, username: "bobby_b" },
    ]);
    // `_` matches only itself, not any one character.
    expect((await (await find("bobby_", "ann")).json()).accounts).toHaveLength(1);
    expect((await (await find("bobbyx", "ann")).json()).accounts).toHaveLength(0);
    expect((await (await find("%", "ann")).json()).accounts).toEqual([]);
    expect((await search.GET(request("GET", "/api/accounts/search?q=bo"))).status).toBe(401);
    let last = 200;
    for (let i = 0; i < 70; i += 1) {
      last = (await find("d", "dan")).status;
    }
    expect(last).toBe(429);
  });

  it("holds an owner to 30 new shares an hour, however often they unshare", async () => {
    await makeUser("erin");
    const designId = "design-share-spam";
    const saved = await design.PUT(
      request(
        "PUT",
        `/api/library/designs/${designId}`,
        "erin",
        upsertBody("Spam", "2026-10-14T11:00:00.000Z"),
      ),
      params({ designId }),
    );
    expect(saved.status).toBe(200);
    const share = (method: "PUT" | "DELETE") =>
      (method === "PUT" ? member.PUT : member.DELETE)(
        request(method, `/api/library/designs/${designId}/members/${users.bob!.id}`, "erin"),
        params({ designId, userId: users.bob!.id }),
      );
    for (let i = 0; i < 30; i += 1) {
      expect((await share("PUT")).status).toBe(200);
      // Sharing again with someone already in it adds nobody.
      if (i === 0) {
        expect((await share("PUT")).status).toBe(200);
      }
      expect((await share("DELETE")).status).toBe(200);
    }
    const refused = await share("PUT");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "You can share with 30 people an hour. Try again later.",
    });
  });
});

describe("when the database fails a read", () => {
  /** The local database, failing every request whose URL names `table` as a stalled Supabase does. */
  function failing(table: string) {
    forgetSessionUsers();
    resetDbBreaker();
    useInProcessLocalDb((req) =>
      req.url.includes(`/rest/v1/${table}`)
        ? Promise.resolve(new Response("<!DOCTYPE html>522", { status: 522, headers: { "content-type": "text/plain" } }))
        : local.handle(req),
    );
  }

  afterEach(() => {
    useInProcessLocalDb(local.handle);
    resetDbBreaker();
  });

  it("fails the library rather than answer it without the plans shared with you", async () => {
    // The client removes every shared copy a library answer leaves out.
    const designId = "design-outage-1";
    await design.PUT(
      request("PUT", `/api/library/designs/${designId}`, "carol", upsertBody("Glass", "2026-10-19T11:00:00.000Z")),
      params({ designId }),
    );
    await member.PUT(
      request("PUT", `/api/library/designs/${designId}/members/${users.dan!.id}`, "carol"),
      params({ designId, userId: users.dan!.id }),
    );
    const healthy = await (await library.GET(request("GET", "/api/library", "dan"))).json();
    expect(healthy.shared).toEqual([expect.objectContaining({ id: designId })]);

    failing("library_design_members");
    const answer = await library.GET(request("GET", "/api/library", "dan"));
    expect(answer.status).toBe(500);
    expect((await answer.json()).shared).toBeUndefined();
  });

  it("says it cannot tell who is signed in, never that nobody is", async () => {
    failing("community_users");
    await expect(library.GET(request("GET", "/api/library", "dan"))).rejects.toThrow(
      "The community database is not responding",
    );
    const me = await meRoute.GET(request("GET", "/api/community/auth/me", "dan"));
    expect(me.status).toBe(503);
    expect(await me.json()).toEqual({
      error: "The community database is not responding. Try again in a few minutes.",
    });

    useInProcessLocalDb(local.handle);
    const back = await meRoute.GET(request("GET", "/api/community/auth/me", "dan"));
    expect(await back.json()).toEqual({ user: { username: "dan", isAdmin: false } });
    const gone = await meRoute.GET(
      new Request("http://localhost/api/community/auth/me", {
        headers: { cookie: `gtnh_session=${makeSessionToken("00000000-0000-4000-8000-000000000000")}` },
      }),
    );
    expect(await gone.json()).toEqual({ user: null });
  });
});
