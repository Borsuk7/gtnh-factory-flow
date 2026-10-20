import { NextResponse } from "next/server";
import type { LibraryListResponse, PlanMember, SharedDesign } from "@/lib/library/sync-types";
import { LIBRARY_MAX_DESIGNS, LIBRARY_MAX_FOLDERS } from "@/lib/library/sync-types";
import { usernamesFor } from "@/lib/server/cloud-plans";
import {
  getCommunityDb,
  getSessionUser,
  isCommunityConfigured,
  parseEntryIcon,
} from "@/lib/server/community";
import {
  DESIGN_META_COLUMNS,
  FOLDER_COLUMNS,
  libraryStorageErrorMessage,
  rowToDesignMeta,
  rowToFolder,
  type DesignRow,
  type FolderRow,
} from "@/lib/server/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MemberRow {
  owner_id: string;
  design_id: string;
  member_id: string;
  added_at: string;
}

const pairKey = (ownerId: string, designId: string) => `${ownerId}:${designId}`;

/**
 * The account's whole library, without plans: every design's metadata and
 * every folder, tombstones included. The browser reconciles against this
 * and fetches only the plans it is missing or that moved. Each design lists
 * who it is shared with, and `shared` lists the plans others shared with
 * this account.
 */
export async function GET(request: Request) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }

  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Sign in to sync your library." }, { status: 401 });
  }

  const db = getCommunityDb();
  const [designs, folders, memberships] = await Promise.all([
    db
      .from("library_designs")
      .select(DESIGN_META_COLUMNS)
      .eq("user_id", sessionUser.id)
      .order("updated_at", { ascending: false })
      .limit(LIBRARY_MAX_DESIGNS * 2),
    db
      .from("library_folders")
      .select(FOLDER_COLUMNS)
      .eq("user_id", sessionUser.id)
      .limit(LIBRARY_MAX_FOLDERS * 2),
    // One read for both sides of sharing: my designs' members, and the
    // designs I am a member of.
    db
      .from("library_design_members")
      .select("owner_id,design_id,member_id,added_at")
      .or(`owner_id.eq.${sessionUser.id},member_id.eq.${sessionUser.id}`)
      .order("added_at", { ascending: true }),
  ]);
  // A database without the members table yet answers as before. Any other
  // failed read fails the whole answer: the client removes every shared copy
  // the answer leaves out, so a partial list would delete them.
  const membersMissing = memberships.error?.code === "PGRST205" || memberships.error?.code === "42P01";
  const error = designs.error ?? folders.error ?? (membersMissing ? null : memberships.error);
  if (error) {
    return NextResponse.json(
      { error: libraryStorageErrorMessage(error, "Your plans could not be loaded.") },
      { status: 500 },
    );
  }

  const memberRows = membersMissing ? [] : ((memberships.data ?? []) as MemberRow[]);
  const ownRows = memberRows.filter((row) => row.owner_id === sessionUser.id);
  const sharedPairs = memberRows.filter(
    (row) => row.member_id === sessionUser.id && row.owner_id !== sessionUser.id,
  );

  // The shared plans themselves, and everyone they are shared with.
  let sharedDesigns: Array<DesignRow & { user_id: string }> = [];
  let sharedMembers: MemberRow[] = [];
  if (sharedPairs.length > 0) {
    const owners = [...new Set(sharedPairs.map((row) => row.owner_id))];
    const ids = [...new Set(sharedPairs.map((row) => row.design_id))];
    const wanted = new Set(sharedPairs.map((row) => pairKey(row.owner_id, row.design_id)));
    const [sharedRead, membersRead] = await Promise.all([
      db
        .from("library_designs")
        .select(`user_id,${DESIGN_META_COLUMNS}`)
        .in("user_id", owners)
        .in("id", ids)
        .is("deleted_at", null),
      db
        .from("library_design_members")
        .select("owner_id,design_id,member_id,added_at")
        .in("owner_id", owners)
        .in("design_id", ids)
        .order("added_at", { ascending: true }),
    ]);
    const sharedError = sharedRead.error ?? membersRead.error;
    if (sharedError) {
      return NextResponse.json(
        { error: libraryStorageErrorMessage(sharedError, "Your plans could not be loaded.") },
        { status: 500 },
      );
    }
    sharedDesigns =((sharedRead.data ?? []) as Array<DesignRow & { user_id: string }>).filter(
      (row) => wanted.has(pairKey(row.user_id, row.id)),
    );
    sharedMembers = ((membersRead.data ?? []) as MemberRow[]).filter((row) =>
      wanted.has(pairKey(row.owner_id, row.design_id)),
    );
  }

  const names = await usernamesFor(db, [
    ...ownRows.map((row) => row.member_id),
    ...sharedMembers.map((row) => row.member_id),
    ...sharedDesigns.map((row) => row.user_id),
  ]).catch(() => new Map<string, string>());

  const membersByDesign = new Map<string, PlanMember[]>();
  for (const row of [...ownRows, ...sharedMembers]) {
    const username = names.get(row.member_id);
    if (!username) {
      continue;
    }
    const key = pairKey(row.owner_id, row.design_id);
    const list = membersByDesign.get(key) ?? [];
    if (!list.some((member) => member.id === row.member_id)) {
      list.push({ id: row.member_id, username });
    }
    membersByDesign.set(key, list);
  }

  const shared: SharedDesign[] = sharedDesigns.map((row) => ({
    ownerId: row.user_id,
    ownerName: names.get(row.user_id) ?? "",
    id: row.id,
    name: row.name,
    icon: parseEntryIcon(row.icon),
    updatedAt: row.updated_at,
    planUpdatedAt: row.plan_updated_at,
    members: membersByDesign.get(pairKey(row.user_id, row.id)) ?? [],
  }));

  const response: LibraryListResponse = {
    designs: (designs.data as DesignRow[]).map((row) => ({
      ...rowToDesignMeta(row),
      members: membersByDesign.get(pairKey(sessionUser.id, row.id)) ?? [],
    })),
    folders: (folders.data as FolderRow[]).map(rowToFolder),
    shared,
  };
  return NextResponse.json(response);
}
