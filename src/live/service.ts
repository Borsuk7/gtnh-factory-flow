import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { readOps } from "@/lib/live/ops";
import {
  colorFor,
  docKey,
  isAccountId,
  LIVE_LIMITS,
  LIVE_PATH,
  LIVE_PROTOCOL_VERSION,
  parseDocKey,
  type LiveClientKind,
  type LiveErrorCode,
  type LiveMember,
  type ServerFrame,
} from "@/lib/live/protocol";
import { sameSecret } from "@/lib/server/cloud-plans";
import { readSessionCookie, verifySessionToken } from "@/lib/server/session";
import { FlushQueue } from "./flush-queue";
import { Journal } from "./journal";
import { Room, type RoomPeer, type RoomTiming } from "./room";
import type { PlanStore } from "./store";

/**
 * The live service: one process beside Next.js holding every open plan in
 * memory (`Room`), speaking the live protocol over WebSockets at `/live`,
 * plus a little HTTP on the same port:
 *
 * - `GET /live/nearby?names=` (cookie): accounts in the asker's game, by the
 *   Minecraft names the asker sees there (see `nearby`).
 * - `GET /live/health`: rooms and connections, for checks after a deploy.
 * - `POST /internal/members` and `/internal/deleted` (LIVE_INTERNAL_TOKEN):
 *   the Next.js routes reporting sharing changes and deleted plans.
 *
 * One live service per database: it takes plan leases without asking whose
 * they were, so a restart picks up its own leases at once.
 */

/** Limits the service keeps beyond the protocol's (LIVE_LIMITS). */
export const SERVICE_LIMITS = {
  /**
   * Milliseconds of batch work (reading, checking, applying) an account may
   * use a second, across its connections, and how much it may bank: past it,
   * batches are refused as `rate` until it refills. A typical batch takes well
   * under one.
   */
  editMsPerSecond: 250,
  editMsBurst: 1000,
  /** A socket with more than this waiting to be sent is reading too slowly: dropped. */
  bufferedBytes: 8 * 1024 * 1024,
  /** A connection already in a plan gets its snapshot again at most this often (and only when it moved on). */
  resnapshotMs: 1000,
  /** Plans one account may have open at once, across all its connections. */
  roomsPerAccount: 8,
  /** Plans open at once in the whole service (LIVE_MAX_ROOMS); past it, joins wait. */
  maxRooms: 500,
  /** Whole-plan writes to the database at once, across every room. */
  flushConcurrency: 4,
  /** Socket upgrades a minute from one account, and from one address (X-Client-Ip behind Caddy). */
  upgradesPerMinuteByAccount: 30,
  upgradesPerMinuteByAddress: 60,
  /** `/live/nearby` asks a minute from one account, and from one address. */
  nearbyPerMinuteByAccount: 20,
  nearbyPerMinuteByAddress: 60,
  /** How long an account looked up for a session is taken as it was. */
  accountCacheMs: 60_000,
};

/** Minecraft names, as the game sends its player's and the names it sees. */
const MC_NAME = /^[A-Za-z0-9_]{1,32}$/;
/** How many names one `/live/nearby` ask may carry. */
const NEARBY_NAMES = 100;

export interface LiveServiceOptions {
  store: PlanStore;
  journalDir: string;
  /** Exact origins a browser may connect from; a client sending none (the game) is let in. */
  allowedOrigins: string[];
  /** Guards /internal/*; unset, they answer 503. */
  internalToken?: string;
  timing?: Partial<RoomTiming>;
  /** Plan size limit in JSON characters (default: the library's upload limit). */
  maxPlanChars?: number;
  limits?: Partial<typeof LIVE_LIMITS & typeof SERVICE_LIMITS>;
  /** A connection silent this long is dropped (default 90 s). */
  idleMs?: number;
  /** Called on POST /internal/shutdown (how dev-local stops it where signals do not reach). */
  onShutdownRequest?: () => void;
  log?: (message: string) => void;
}

const DEFAULT_TIMING: RoomTiming = {
  flushMs: 8000,
  renewMs: 30_000,
  leaseMs: 90_000,
  lingerMs: 60_000,
};
const HELLO_WAIT_MS = 10_000;
const FRAMES_PER_SECOND = 200;
const JOINS_PER_SECOND = 10;
/** Sockets one account may hold at once (a game and a few browser tabs). */
const CONNECTIONS_PER_ACCOUNT = 16;

/** A bucket of milliseconds refilled at a steady rate, for one account's batch work. */
class TimeBudget {
  private left: number;
  private at = performance.now();
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {
    this.left = burst;
  }
  private refill(): void {
    const now = performance.now();
    this.left = Math.min(this.burst, this.left + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
  }
  allows(): boolean {
    this.refill();
    return this.left > 0;
  }
  spend(ms: number): void {
    this.refill();
    this.left -= ms;
  }
}

class RateWindow {
  private stamps: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs = 1000,
  ) {}
  /** Nothing in the window: it can be forgotten. */
  quiet(now = Date.now()): boolean {
    const last = this.stamps[this.stamps.length - 1];
    return last === undefined || last <= now - this.windowMs;
  }
  take(now = Date.now()): boolean {
    const since = now - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! <= since) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.limit) {
      return false;
    }
    this.stamps.push(now);
    return true;
  }
}

/** A RateWindow per key (an account, an address); keys gone quiet are forgotten. */
class RateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  take(key: string): boolean {
    let window = this.windows.get(key);
    if (!window) {
      window = new RateWindow(this.limit, this.windowMs);
      this.windows.set(key, window);
    }
    return window.take();
  }
  sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.quiet(now)) {
        this.windows.delete(key);
      }
    }
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Where a request came from. Behind Caddy (the service listens on loopback)
 * that is the X-Client-Ip header Caddy sets from Cloudflare's client address,
 * overwriting whatever the client sent; CF-Connecting-IP when it is missing.
 * A request not from loopback came straight to the service: its own address.
 */
function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!LOOPBACK.has(peer)) {
    return peer;
  }
  const header = (name: string) => {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined;
  };
  return header("x-client-ip") ?? header("cf-connecting-ip") ?? peer;
}

interface Connection extends RoomPeer {
  ws: WebSocket;
  hello: boolean;
  gameServer?: string;
  /** The player's Minecraft name in that game (lower case), when the game sent it. */
  mcName?: string;
  rooms: Map<string, Room>;
  lastSeen: number;
  frames: RateWindow;
  batches: RateWindow;
  joins: RateWindow;
  presenceAt: number;
  presencePending: Map<string, ServerFrame>;
  presenceTimer?: ReturnType<typeof setTimeout>;
  /** The last snapshot sent per plan: its seq and when. */
  snapshots: Map<string, { seq: number; at: number }>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

export class LiveService {
  readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly journal: Journal;
  private readonly rooms = new Map<string, Promise<Room | undefined>>();
  /** The rooms open now (not opening, not closed), oldest first. */
  private readonly openRooms = new Set<Room>();
  private readonly connections = new Set<Connection>();
  /** Each account's connections. */
  private readonly byUser = new Map<string, Set<Connection>>();
  private readonly flushes: FlushQueue;
  private readonly cids = new Map<string, number>();
  private readonly timing: RoomTiming;
  private readonly limits: typeof LIVE_LIMITS & typeof SERVICE_LIMITS;
  /** Each account's batch work budget, while it has connections. */
  private readonly budgets = new Map<string, TimeBudget>();
  private readonly origins: Set<string>;
  private readonly log: (message: string) => void;
  private readonly upgradesByAccount: RateLimiter;
  private readonly upgradesByAddress: RateLimiter;
  private readonly nearbyByAccount: RateLimiter;
  private readonly nearbyByAddress: RateLimiter;
  /** Accounts looked up for sessions, each kept `accountCacheMs`. */
  private readonly accounts = new Map<
    string,
    { at: number; account: Promise<{ id: string; username: string } | undefined> }
  >();
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(private readonly options: LiveServiceOptions) {
    this.journal = new Journal(options.journalDir);
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.limits = { ...LIVE_LIMITS, ...SERVICE_LIMITS, ...options.limits };
    this.flushes = new FlushQueue(this.limits.flushConcurrency);
    this.upgradesByAccount = new RateLimiter(this.limits.upgradesPerMinuteByAccount, 60_000);
    this.upgradesByAddress = new RateLimiter(this.limits.upgradesPerMinuteByAddress, 60_000);
    this.nearbyByAccount = new RateLimiter(this.limits.nearbyPerMinuteByAccount, 60_000);
    this.nearbyByAddress = new RateLimiter(this.limits.nearbyPerMinuteByAddress, 60_000);
    this.origins = new Set(
      options.allowedOrigins.map(normalizeOrigin).filter((origin): origin is string => !!origin),
    );
    this.log = options.log ?? ((message) => console.log(`[live] ${message}`));
    this.server = createServer((req, res) => {
      void this.handleHttp(req)
        .then(({ status, body }) => {
          res.writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(body));
        })
        .catch((error) => {
          this.log(`http ${req.url}: ${String(error)}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Live service error." }));
        });
    });
    // A frame up to twice the batch limit is read and refused by name (its
    // cid, so the client drops that batch); a bigger one closes the socket
    // before it is ever buffered whole.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.batchBytes * 2,
      perMessageDeflate: false,
    });
    this.server.on("upgrade", (req, socket, head) => void this.handleUpgrade(req, socket, head));
  }

  /** Replays journals left by a crash, then listens. */
  async start(port: number, host = "127.0.0.1"): Promise<number> {
    await this.replayJournals();
    await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
    const idleMs = this.options.idleMs ?? 90_000;
    this.heartbeat = setInterval(
      () => {
        const now = Date.now();
        for (const conn of this.connections) {
          if (now - conn.lastSeen > idleMs) {
            conn.ws.terminate();
          } else if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.ping();
          }
        }
        for (const limiter of [
          this.upgradesByAccount,
          this.upgradesByAddress,
          this.nearbyByAccount,
          this.nearbyByAddress,
        ]) {
          limiter.sweep(now);
        }
        for (const [userId, cached] of this.accounts) {
          if (now - cached.at >= this.limits.accountCacheMs) {
            this.accounts.delete(userId);
          }
        }
      },
      Math.min(30_000, idleMs / 3),
    );
    this.heartbeat.unref?.();
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  /** Every plan journalled but not stored (the service stopped hard): stored now. */
  private async replayJournals(): Promise<void> {
    for (const doc of await this.journal.docs()) {
      try {
        const room = await this.room(doc);
        if (!room) {
          this.log(`${doc}: journal for a missing or deleted plan, dropped`);
          await this.journal.remove(doc);
        } else if (room.peers.size === 0) {
          await room.closeIfEmpty();
        }
      } catch (error) {
        this.log(`${doc}: replay failed, journal kept: ${String(error)}`);
      }
    }
  }

  /** Stops taking connections, stores every open plan and lets its lease go, closes every socket. */
  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    clearInterval(this.heartbeat);
    // Every room's last flush goes now, whatever pause the database earned.
    this.flushes.drain();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const rooms = await Promise.all(
      [...this.rooms.values()].map((room) => room.catch(() => undefined)),
    );
    await Promise.all(rooms.map((room) => room?.shutdown()));
    for (const conn of this.connections) {
      conn.ws.close(1001, "The live service is restarting");
    }
    this.wss.close();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  /** Drops everything at once and stores nothing: a crash, for tests of the journal. */
  async crash(): Promise<void> {
    this.stopping = true;
    clearInterval(this.heartbeat);
    const rooms = await Promise.all(
      [...this.rooms.values()].map((room) => room.catch(() => undefined)),
    );
    rooms.forEach((room) => room?.abandon());
    this.rooms.clear();
    for (const conn of this.connections) {
      conn.ws.terminate();
    }
    this.wss.close();
    this.server.close();
  }

  get stats(): { rooms: number; connections: number; flushBacklog: number } {
    return {
      rooms: this.rooms.size,
      connections: this.connections.size,
      flushBacklog: this.flushes.backlog,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP

  private async handleHttp(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", "http://live.local");
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname === `${LIVE_PATH}/health`) {
      return { status: 200, body: { ok: !this.stopping, ...this.stats } };
    }
    if (method === "GET" && url.pathname === `${LIVE_PATH}/nearby`) {
      if (!this.nearbyByAddress.take(clientAddress(req))) {
        return { status: 429, body: { error: "Too many asks. Try again in a minute." } };
      }
      const session = this.session(req);
      if (!session) {
        return { status: 401, body: { error: "Sign in first." } };
      }
      if (!this.nearbyByAccount.take(session.userId)) {
        return { status: 429, body: { error: "Too many asks. Try again in a minute." } };
      }
      const user = await this.account(session.userId);
      if (!user) {
        return { status: 401, body: { error: "Sign in first." } };
      }
      const names = readNames(url.searchParams.get("names"));
      return { status: 200, body: { accounts: this.nearby(user.id, names) } };
    }
    if (method === "POST" && url.pathname.startsWith("/internal/")) {
      if (!this.options.internalToken) {
        return { status: 503, body: { error: "Internal calls are not set up." } };
      }
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!sameSecret(token, this.options.internalToken)) {
        return { status: 401, body: { error: "Wrong token." } };
      }
      if (url.pathname === "/internal/shutdown" && this.options.onShutdownRequest) {
        setTimeout(() => this.options.onShutdownRequest?.(), 10);
        return { status: 200, body: { ok: true } };
      }
      const body = (await readJson(req)) as InternalBody;
      const key = parseDocKey(body?.doc);
      if (!key) {
        return { status: 400, body: { error: "Bad doc." } };
      }
      const doc = docKey(key.ownerId, key.designId);
      if (url.pathname === "/internal/members") {
        const members = readMembers(body.members);
        if (!members) {
          return { status: 400, body: { error: "Bad members." } };
        }
        const room = await this.rooms.get(doc)?.catch(() => undefined);
        if (room) {
          await room.enqueue(() => room.updateMembers(members));
        }
        this.announceSharing(doc, body);
        return { status: 200, body: { ok: true, open: Boolean(room) } };
      }
      if (url.pathname === "/internal/deleted") {
        const room = await this.rooms.get(doc)?.catch(() => undefined);
        if (room) {
          await room.drop("deleted");
        } else {
          await this.journal.remove(doc);
        }
        return { status: 200, body: { ok: true, open: Boolean(room) } };
      }
    }
    return { status: 404, body: { error: "Not found." } };
  }

  /**
   * Tells every open socket of an account just added to a plan (`shared`,
   * with the owner and the plan's name) or just removed from it
   * (`unshared`), in or out of the plan's room. The REST route names who
   * changed; a notice without them announces nothing.
   */
  private announceSharing(doc: string, body: InternalBody): void {
    const owner = body.owner as { id?: unknown; username?: unknown } | undefined;
    if (Array.isArray(body.added) && isAccountId(owner?.id) && typeof owner?.username === "string") {
      const frame: ServerFrame = {
        t: "shared",
        doc,
        owner: { id: owner.id.toLowerCase(), username: owner.username },
        name: typeof body.name === "string" ? body.name.slice(0, 200) : "",
      };
      for (const id of body.added) {
        if (isAccountId(id)) {
          for (const conn of this.byUser.get(id.toLowerCase()) ?? []) {
            conn.send(frame);
          }
        }
      }
    }
    if (Array.isArray(body.removed)) {
      for (const id of body.removed) {
        if (isAccountId(id)) {
          for (const conn of this.byUser.get(id.toLowerCase()) ?? []) {
            conn.send({ t: "unshared", doc });
          }
        }
      }
    }
  }

  /**
   * Signed-in accounts in the asker's game, for the game's share helper:
   * connected from a game with the same server hash as one of the asker's
   * game connections, and playing under one of `names`, the Minecraft names
   * the asker's game shows it (its tab list). Knowing a server's address is
   * not enough to list who is on it: the asker must already see them there.
   */
  private nearby(userId: string, names: ReadonlySet<string>): LiveMember[] {
    const servers = new Set<string>();
    for (const conn of this.byUser.get(userId) ?? []) {
      if (conn.gameServer) {
        servers.add(conn.gameServer);
      }
    }
    const found = new Map<string, LiveMember>();
    if (servers.size === 0 || names.size === 0) {
      return [];
    }
    for (const conn of this.connections) {
      if (
        conn.userId !== userId &&
        conn.gameServer &&
        servers.has(conn.gameServer) &&
        conn.mcName &&
        names.has(conn.mcName)
      ) {
        found.set(conn.userId, { id: conn.userId, username: conn.username });
      }
    }
    return [...found.values()];
  }

  /** The account a request's session cookie names, when its signature holds (no database). */
  private session(req: IncomingMessage): { userId: string } | undefined {
    const token = readSessionCookie(req.headers.cookie);
    return token ? verifySessionToken(token) : undefined;
  }

  /** An account by id, looked up at most once every `accountCacheMs`. */
  private account(userId: string): Promise<{ id: string; username: string } | undefined> {
    const cached = this.accounts.get(userId);
    if (cached && Date.now() - cached.at < this.limits.accountCacheMs) {
      return cached.account;
    }
    const account = this.options.store.account(userId);
    const entry = { at: Date.now(), account };
    this.accounts.set(userId, entry);
    account.catch(() => {
      if (this.accounts.get(userId) === entry) {
        this.accounts.delete(userId);
      }
    });
    return account;
  }

  // -------------------------------------------------------------------------
  // Sockets

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://live.local");
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== LIVE_PATH || this.stopping) {
      refuse(404, "Not Found");
      return;
    }
    // Browsers always send Origin; it must be one of ours. The game sends none.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const normalized = normalizeOrigin(origin);
      if (!normalized || !this.origins.has(normalized)) {
        refuse(403, "Forbidden");
        return;
      }
    }
    // Limits first, all without the database: an address, then the account
    // the session names (its signature checked here), then its sockets.
    if (!this.upgradesByAddress.take(clientAddress(req))) {
      refuse(429, "Too Many Requests");
      return;
    }
    const session = this.session(req);
    if (session && !this.upgradesByAccount.take(session.userId)) {
      refuse(429, "Too Many Requests");
      return;
    }
    const tooMany = () =>
      !!session && (this.byUser.get(session.userId)?.size ?? 0) >= CONNECTIONS_PER_ACCOUNT;
    let user: { id: string; username: string } | undefined;
    let lookupFailed = false;
    if (session && !tooMany()) {
      try {
        user = await this.account(session.userId);
      } catch (error) {
        lookupFailed = true;
        this.log(`sign-in check failed: ${String(error)}`);
      }
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (tooMany()) {
        ws.send(JSON.stringify({ t: "error", code: "rate", msg: "Too many live connections." }));
        ws.close(4029, "rate");
        return;
      }
      if (lookupFailed) {
        // The database did not answer: not a refused sign-in (4001 tells a
        // client to stop until the player signs in again), so try again later.
        ws.close(1013, "try again");
        return;
      }
      if (!user) {
        ws.send(JSON.stringify({ t: "error", code: "auth", msg: "Sign in to use live plans." }));
        ws.close(4001, "auth");
        return;
      }
      this.accept(ws, user);
    });
  }

  private accept(ws: WebSocket, user: { id: string; username: string }): void {
    const conn: Connection = {
      connId: randomBytes(6).toString("hex"),
      userId: user.id,
      username: user.username,
      client: "web",
      ws,
      hello: false,
      rooms: new Map(),
      lastSeen: Date.now(),
      frames: new RateWindow(FRAMES_PER_SECOND),
      batches: new RateWindow(this.limits.batchesPerSecond),
      joins: new RateWindow(JOINS_PER_SECOND),
      presenceAt: 0,
      presencePending: new Map(),
      snapshots: new Map(),
      forget: (doc) => {
        conn.rooms.delete(doc);
        conn.presencePending.delete(doc);
        conn.snapshots.delete(doc);
      },
      send: (frame) => conn.sendText(JSON.stringify(frame)),
      // A room that failed: the client reconnects as after a restart, joins
      // again and sends what it has not had acknowledged.
      reload: () => ws.close(1012, "reload"),
      sendText: (text) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(text);
        if (ws.bufferedAmount > this.limits.bufferedBytes) {
          // Not reading what it is sent: everything waiting would sit in memory.
          this.log(`connection ${conn.connId}: over ${this.limits.bufferedBytes} bytes unsent, dropped`);
          ws.terminate();
        }
      },
    };
    this.connections.add(conn);
    let mine = this.byUser.get(conn.userId);
    if (!mine) {
      mine = new Set();
      this.byUser.set(conn.userId, mine);
    }
    mine.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.hello) {
        ws.close(4002, "hello");
      }
    }, HELLO_WAIT_MS);
    helloTimer.unref?.();
    ws.on("pong", () => (conn.lastSeen = Date.now()));
    ws.on("message", (data, isBinary) => {
      conn.lastSeen = Date.now();
      void this.onMessage(conn, data, isBinary).catch((error) => {
        this.log(`connection ${conn.connId}: ${String(error)}`);
        this.error(conn, "bad_op", "The live service could not handle that.");
      });
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clearTimeout(conn.presenceTimer);
      this.connections.delete(conn);
      const others = this.byUser.get(conn.userId);
      others?.delete(conn);
      if (!others || others.size === 0) {
        this.byUser.delete(conn.userId);
        this.budgets.delete(conn.userId);
      }
      for (const room of conn.rooms.values()) {
        void room.enqueue(() => room.leave(conn));
      }
      conn.rooms.clear();
    });
    ws.on("error", () => ws.terminate());
  }

  private error(
    conn: Connection,
    code: LiveErrorCode,
    msg: string,
    extra: { doc?: string; cid?: string } = {},
  ): void {
    conn.send({ t: "error", ...extra, code, msg });
  }

  private async onMessage(conn: Connection, data: RawData, isBinary: boolean): Promise<void> {
    if (!conn.frames.take()) {
      this.error(conn, "rate", "Too many frames.");
      conn.ws.close(1008, "rate");
      return;
    }
    if (isBinary) {
      this.error(conn, "bad_op", "Frames are JSON text.");
      return;
    }
    const bytes = Array.isArray(data)
      ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      : data.byteLength;
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data as ArrayBuffer).toString("utf8");
    // Sized before it is parsed: only a batch may be big, and a big frame
    // counts as a batch for the rate before any work is done on it.
    const big = bytes > this.limits.frameBytes;
    if (big) {
      const named = peekNames(text);
      if (bytes > this.limits.batchBytes) {
        this.error(conn, "too_big", "That frame is too big.", named);
        return;
      }
      if (!conn.batches.take()) {
        this.error(conn, "rate", "Too many edits a second.", named);
        return;
      }
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.error(conn, "bad_op", "Frames are JSON objects.");
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      this.error(conn, "bad_op", "Frames are JSON objects.");
      return;
    }
    const doc = typeof frame.doc === "string" ? frame.doc : undefined;
    const cid = typeof frame.cid === "string" ? frame.cid.slice(0, 100) : undefined;
    if (big && frame.t !== "ops") {
      this.error(conn, "too_big", "That frame is too big.", { doc, cid });
      return;
    }
    if (!conn.hello && frame.t !== "hello") {
      this.error(conn, "version", "Send hello first.");
      conn.ws.close(1002, "hello");
      return;
    }
    switch (frame.t) {
      case "hello":
        return this.onHello(conn, frame);
      case "join":
        return this.onJoin(conn, doc);
      case "leave":
        return this.onLeave(conn, doc);
      case "ops":
        return this.onOps(conn, frame, doc, cid, big);
      case "presence":
        return this.onPresence(conn, frame, doc);
      case "ping":
        conn.send({ t: "pong" });
        return;
      default:
        this.error(conn, "bad_op", "Unknown frame.", { doc });
    }
  }

  private onHello(conn: Connection, frame: Record<string, unknown>): void {
    if (frame.v !== LIVE_PROTOCOL_VERSION) {
      this.error(conn, "version", `This service speaks version ${LIVE_PROTOCOL_VERSION}.`);
      conn.ws.close(1002, "version");
      return;
    }
    const client: LiveClientKind = frame.client === "game" ? "game" : "web";
    (conn as { client: LiveClientKind }).client = client;
    const game = frame.game as { server?: unknown; mcName?: unknown } | undefined;
    if (client === "game" && game && typeof game.server === "string" && game.server.length <= 128) {
      conn.gameServer = game.server;
      if (typeof game.mcName === "string" && MC_NAME.test(game.mcName)) {
        conn.mcName = game.mcName.toLowerCase();
      }
    }
    conn.hello = true;
    conn.send({
      t: "welcome",
      v: LIVE_PROTOCOL_VERSION,
      you: { id: conn.userId, username: conn.username, color: colorFor(conn.userId) },
    });
  }

  /** The open room for a doc, opening it when needed; undefined when the design is missing or deleted. */
  private room(doc: string): Promise<Room | undefined> {
    const existing = this.rooms.get(doc);
    if (existing) {
      return existing;
    }
    const opening = Room.open(doc, {
      store: this.options.store,
      journal: this.journal,
      flushes: this.flushes,
      timing: this.timing,
      maxPlanChars: this.options.maxPlanChars,
      cids: this.cids,
      log: this.log,
      onClosed: (room) => {
        this.openRooms.delete(room);
        if (this.rooms.get(room.doc) === opening) {
          this.rooms.delete(room.doc);
        }
        for (const conn of this.connections) {
          if (conn.rooms.get(room.doc) === room) {
            conn.rooms.delete(room.doc);
          }
        }
      },
    });
    this.rooms.set(doc, opening);
    void opening.then(
      (room) => {
        if (room && !room.closed) {
          this.openRooms.add(room);
        }
        if (!room && this.rooms.get(doc) === opening) {
          this.rooms.delete(doc);
        }
      },
      () => {
        if (this.rooms.get(doc) === opening) {
          this.rooms.delete(doc);
        }
      },
    );
    return opening;
  }

  private async onJoin(conn: Connection, rawDoc: string | undefined): Promise<void> {
    const key = parseDocKey(rawDoc);
    if (!key) {
      this.error(conn, "not_found", "No such plan.", { doc: rawDoc });
      return;
    }
    const doc = docKey(key.ownerId, key.designId);
    if (!conn.joins.take()) {
      this.error(conn, "rate", "Too many joins a second.", { doc });
      return;
    }
    const current = conn.rooms.get(doc);
    if (current) {
      // Already in it: a client that missed batches asks again. A snapshot
      // only when the plan moved on since the last one, at most once a
      // `resnapshotMs`; otherwise nothing, as it already has everything.
      await current.enqueue(async () => {
        try {
          await current.whenDurable();
        } catch {
          return;
        }
        const last = conn.snapshots.get(doc);
        if (
          !current.closed &&
          current.peers.has(conn) &&
          (!last ||
            (last.seq !== current.seq && Date.now() - last.at >= this.limits.resnapshotMs))
        ) {
          const role = conn.userId === current.ownerId ? "owner" : "editor";
          conn.snapshots.set(doc, { seq: current.seq, at: Date.now() });
          conn.sendText(current.snapshotText(role));
        }
      });
      return;
    }
    if (conn.rooms.size >= this.limits.roomsPerConnection) {
      this.error(conn, "rate", "Too many plans open at once.", { doc });
      return;
    }
    const held = this.plansOpenBy(conn.userId);
    if (!held.has(doc) && held.size >= this.limits.roomsPerAccount) {
      this.error(conn, "rate", "Too many plans open at once.", { doc });
      return;
    }
    if (!this.rooms.has(doc)) {
      if (this.rooms.size >= this.limits.maxRooms) {
        // Full: a plan nobody is in makes room, and the client asks again.
        this.closeOneIdleRoom();
        this.error(conn, "rate", "The live service is busy. Try again shortly.", { doc });
        return;
      }
      // Not open: the database says whether it may be, before anything is
      // opened for it. An open room answers from its own members below.
      let role: Awaited<ReturnType<PlanStore["role"]>>;
      try {
        role = await this.options.store.role(conn.userId, key.ownerId, key.designId);
      } catch (error) {
        this.log(`${doc}: membership check failed: ${String(error)}`);
        this.error(conn, "rate", "The plan could not be opened. Try again shortly.", { doc });
        return;
      }
      if (!role) {
        this.error(conn, "forbidden", "This plan is not shared with you.", { doc });
        return;
      }
    }
    // A room closing as we arrive is replaced by a fresh one.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let opened: Room | undefined;
      try {
        opened = await this.room(doc);
      } catch (error) {
        this.log(`${doc}: open failed: ${String(error)}`);
        // Not not_found: a client removes its copy of a shared plan on that.
        // The database did not answer, so the client asks again shortly.
        this.error(conn, "rate", "The plan could not be opened. Try again shortly.", { doc });
        return;
      }
      if (!opened) {
        this.error(conn, "not_found", "No such plan.", { doc });
        return;
      }
      const room = opened;
      const joined = await room.enqueue(async () => {
        // A snapshot holds nothing that is not on disk yet.
        try {
          await room.whenDurable();
        } catch {
          return false;
        }
        if (room.closed) {
          return false;
        }
        if (conn.ws.readyState !== WebSocket.OPEN || room.peers.has(conn)) {
          return true;
        }
        // Checked in the room's turn against the members it holds, which
        // sharing notices and every lease renewal keep current: someone
        // unshared a moment ago is never let in.
        const role = room.roleOf(conn.userId);
        if (!role) {
          this.error(conn, "forbidden", "This plan is not shared with you.", { doc });
          return true;
        }
        room.admit(conn);
        conn.rooms.set(doc, room);
        conn.snapshots.set(doc, { seq: room.seq, at: Date.now() });
        conn.sendText(room.snapshotText(role));
        room.broadcast({ t: "present", doc, present: room.present }, conn);
        return true;
      });
      if (joined) {
        return;
      }
    }
    this.error(conn, "not_found", "The plan could not be opened. Try again.", { doc });
  }

  /** The plans an account has open, across its connections. */
  private plansOpenBy(userId: string): Set<string> {
    const docs = new Set<string>();
    for (const conn of this.byUser.get(userId) ?? []) {
      for (const doc of conn.rooms.keys()) {
        docs.add(doc);
      }
    }
    return docs;
  }

  /** Closes the room nobody has been in the longest, to make room for another. */
  private closeOneIdleRoom(): void {
    for (const room of this.openRooms) {
      if (room.idle) {
        void room.closeIfEmpty();
        return;
      }
    }
  }

  private async onLeave(conn: Connection, rawDoc: string | undefined): Promise<void> {
    const key = parseDocKey(rawDoc);
    const doc = key ? docKey(key.ownerId, key.designId) : undefined;
    const room = doc ? conn.rooms.get(doc) : undefined;
    if (!room || !doc) {
      return;
    }
    conn.rooms.delete(doc);
    conn.presencePending.delete(doc);
    conn.snapshots.delete(doc);
    await room.enqueue(() => room.leave(conn));
  }

  private async onOps(
    conn: Connection,
    frame: Record<string, unknown>,
    rawDoc: string | undefined,
    cid: string | undefined,
    rated: boolean,
  ): Promise<void> {
    const key = parseDocKey(rawDoc);
    const doc = key ? docKey(key.ownerId, key.designId) : rawDoc;
    const room = doc ? conn.rooms.get(doc) : undefined;
    if (!room || !doc) {
      this.error(conn, "forbidden", "Join the plan first.", { doc: rawDoc, cid });
      return;
    }
    if (!cid) {
      this.error(conn, "bad_op", "A batch needs a cid.", { doc });
      return;
    }
    if (!rated && !conn.batches.take()) {
      this.error(conn, "rate", "Too many edits a second.", { doc, cid });
      return;
    }
    if (Array.isArray(frame.ops) && frame.ops.length > this.limits.opsPerBatch) {
      this.error(conn, "too_big", "Too many changes in one batch.", { doc, cid });
      return;
    }
    const budget = this.budget(conn.userId);
    if (!budget.allows()) {
      this.error(conn, "rate", "Too much editing at once. It goes again shortly.", { doc, cid });
      return;
    }
    const readStarted = performance.now();
    const read = readOps(frame.ops);
    budget.spend(performance.now() - readStarted);
    if ("error" in read) {
      this.error(conn, "bad_op", read.error, { doc, cid });
      return;
    }
    if (read.ops.length === 0) {
      conn.send({ t: "ops", doc, seq: room.seq, by: conn.userId, cid, ops: [] });
      return;
    }
    const result = await room.enqueue(async () => {
      if (!room.peers.has(conn)) {
        return undefined;
      }
      const started = performance.now();
      const applied = room.apply(conn, cid, read.ops);
      budget.spend(performance.now() - started);
      return applied;
    });
    if (!result) {
      this.error(conn, "forbidden", "Join the plan first.", { doc, cid });
    } else if (result.kind === "duplicate") {
      // Applied before (sent again after a reconnect): acknowledged to its
      // sender alone, with nothing to apply, once it is on disk.
      try {
        await room.whenDurable();
      } catch {
        return;
      }
      conn.send({ t: "ops", doc, seq: result.seq, by: conn.userId, cid, ops: [] });
    } else if (result.kind === "refused") {
      this.error(conn, result.code, result.msg, { doc, cid });
    }
  }

  private budget(userId: string): TimeBudget {
    let budget = this.budgets.get(userId);
    if (!budget) {
      budget = new TimeBudget(this.limits.editMsPerSecond, this.limits.editMsBurst);
      this.budgets.set(userId, budget);
    }
    return budget;
  }

  private onPresence(
    conn: Connection,
    frame: Record<string, unknown>,
    rawDoc: string | undefined,
  ): void {
    const key = parseDocKey(rawDoc);
    const doc = key ? docKey(key.ownerId, key.designId) : undefined;
    const room = doc ? conn.rooms.get(doc) : undefined;
    if (!room || !doc || !room.peers.has(conn)) {
      return;
    }
    const cursor = frame.cursor as { x?: unknown; y?: unknown } | null | undefined;
    const sel = frame.sel;
    const view = frame.view as { x?: unknown; y?: unknown; zoom?: unknown } | undefined;
    const cursorOk = cursor === null || (isFiniteNumber(cursor?.x) && isFiniteNumber(cursor?.y));
    const selOk =
      Array.isArray(sel) &&
      sel.length <= this.limits.selectionIds &&
      sel.every((id) => typeof id === "string" && id.length <= 200);
    const viewOk =
      view === undefined ||
      (isFiniteNumber(view?.x) && isFiniteNumber(view?.y) && isFiniteNumber(view?.zoom));
    if (!cursorOk || !selOk || !viewOk) {
      this.error(conn, "bad_op", "Presence is a cursor, a selection and maybe a view.", { doc });
      return;
    }
    const relay: ServerFrame = {
      t: "presence",
      doc,
      who: conn.userId,
      conn: conn.connId,
      cursor: cursor === null ? null : { x: cursor!.x as number, y: cursor!.y as number },
      sel: sel as string[],
      ...(view
        ? { view: { x: view.x as number, y: view.y as number, zoom: view.zoom as number } }
        : {}),
    };
    // At most `presencePerSecond` relayed; between, only the latest is kept
    // and goes out when the next slot comes, so the last position always lands.
    conn.presencePending.set(doc, relay);
    this.flushPresence(conn);
  }

  private flushPresence(conn: Connection): void {
    if (conn.presenceTimer) {
      return;
    }
    const gap = 1000 / this.limits.presencePerSecond;
    const wait = conn.presenceAt + gap - Date.now();
    if (wait > 0) {
      conn.presenceTimer = setTimeout(() => {
        conn.presenceTimer = undefined;
        this.flushPresence(conn);
      }, wait);
      conn.presenceTimer.unref?.();
      return;
    }
    const next = conn.presencePending.entries().next();
    if (next.done) {
      return;
    }
    const [doc, frame] = next.value;
    conn.presencePending.delete(doc);
    conn.presenceAt = Date.now();
    conn.rooms.get(doc)?.broadcast(frame, conn);
    if (conn.presencePending.size > 0) {
      this.flushPresence(conn);
    }
  }
}

/** The Minecraft names a `/live/nearby` ask carries (`names=a,b,c`), lower case, at most NEARBY_NAMES. */
function readNames(raw: string | null): Set<string> {
  const names = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim();
    if (MC_NAME.test(name)) {
      names.add(name.toLowerCase());
      if (names.size >= NEARBY_NAMES) {
        break;
      }
    }
  }
  return names;
}

/**
 * The doc and cid of a frame too big to parse, read off its first and last
 * kilobyte (clients put them before or after the ops), so the refusal still
 * names the batch and its sender can drop it.
 */
function peekNames(text: string): { doc?: string; cid?: string } {
  const ends = [text.slice(0, 1024), text.slice(-1024)];
  const find = (name: string): string | undefined => {
    const pattern = new RegExp(String.raw`"${name}"\s*:\s*"((?:[^"\\]|\\.){1,200})"`);
    for (const part of ends) {
      const match = pattern.exec(part);
      if (match) {
        try {
          return (JSON.parse(`"${match[1]}"`) as string).slice(0, 100);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
  const named: { doc?: string; cid?: string } = {};
  const doc = find("doc");
  const cid = find("cid");
  if (doc) {
    named.doc = doc;
  }
  if (cid) {
    named.cid = cid;
  }
  return named;
}

async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

interface InternalBody {
  doc?: unknown;
  members?: unknown;
  added?: unknown;
  removed?: unknown;
  owner?: unknown;
  name?: unknown;
}

function readMembers(value: unknown): LiveMember[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const members: LiveMember[] = [];
  for (const item of value) {
    const member = item as { id?: unknown; username?: unknown };
    if (!isAccountId(member?.id) || typeof member.username !== "string") {
      return undefined;
    }
    members.push({ id: member.id.toLowerCase(), username: member.username });
  }
  return members;
}
