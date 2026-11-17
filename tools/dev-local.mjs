#!/usr/bin/env node
/**
 * `npm run dev:local`: the whole site on this machine with no Supabase
 * credentials anywhere. Starts, in order:
 *
 * 1. the local database (PGlite, `tools/local-db/serve.ts`) on 127.0.0.1:54329,
 *    data in scratch/local-db/pgdata;
 * 2. the live service (`src/live/main.ts`) on :3001, journal in
 *    scratch/local-db/live-journal;
 * 3. `next dev` on :3000.
 *
 * Next.js and the live service run with LOCAL_DB=1 and a development-only
 * COMMUNITY_HASH_SALT, so sign-ins made here work only here. Ctrl+C stops
 * everything; the database closes cleanly first.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPort = Number(process.env.LOCAL_DB_PORT ?? 54329);
const livePort = Number(process.env.LIVE_PORT ?? 3001);
const webPort = Number(process.env.PORT ?? 3000);
const dbUrl = `http://127.0.0.1:${dbPort}`;

const shared = {
  LOCAL_DB: "1",
  LOCAL_DB_URL: dbUrl,
  // Development only: tokens signed with it are worthless anywhere else.
  COMMUNITY_HASH_SALT: "local-development-salt-not-a-secret",
  LIVE_INTERNAL_TOKEN: "local-development-internal-token",
  LIVE_INTERNAL_URL: `http://127.0.0.1:${livePort}`,
};

const bin = {
  tsx: path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
  next: path.join(root, "node_modules", "next", "dist", "bin", "next"),
};

const children = [];

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${name}] `;
  const relay = (stream, out) => {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (text) => {
      buffered += text;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        out.write(line.startsWith(prefix) ? `${line}\n` : `${prefix}${line}\n`);
      }
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code ?? "signal"})`);
    if (!stopping) {
      void stop(1);
    }
  });
  children.push(child);
  return child;
}

async function waitFor(url, label, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} did not start within ${timeoutMs / 1000} s`);
}

let stopping = false;
async function stop(code = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  // The live service first (it stores open plans), then the database, both
  // gently: on Windows a child process gets no signal.
  await fetch(`${shared.LIVE_INTERNAL_URL}/internal/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${shared.LIVE_INTERNAL_TOKEN}` },
  }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await fetch(`${dbUrl}/__local-db/shutdown`, { method: "POST" }).catch(() => undefined);
  const exited = children.map(
    (child) =>
      new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve))),
  );
  await Promise.race([Promise.all(exited), new Promise((resolve) => setTimeout(resolve, 5000))]);
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

// What `npm run dev` does first (its predev script).
for (const script of ["tools/copy-highs-wasm.mjs", "tools/build-community-stats.mjs"]) {
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

start("local-db", [bin.tsx, "tools/local-db/serve.ts"], { LOCAL_DB_PORT: String(dbPort) });
await waitFor(`${dbUrl}/rest/v1/community_users?select=id&limit=1`, "The local database");

if (existsSync(path.join(root, "src", "live", "main.ts"))) {
  start("live", [bin.tsx, "src/live/main.ts"], {
    ...shared,
    LIVE_PORT: String(livePort),
    LIVE_JOURNAL_DIR: path.join(root, "scratch", "local-db", "live-journal"),
    LIVE_ALLOWED_ORIGINS: `http://localhost:${webPort},http://127.0.0.1:${webPort}`,
  });
}

start("next", [bin.next, "dev", "--port", String(webPort)], {
  ...shared,
  NEXT_PUBLIC_LIVE_URL: `ws://localhost:${livePort}/live`,
});

console.log(`[dev-local] http://localhost:${webPort} with the local database at ${dbUrl}`);
