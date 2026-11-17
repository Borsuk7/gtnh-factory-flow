import { assertLocalDbAllowed } from "./local-db/client";
import { areOnlineFeaturesEnabled } from "@/lib/online-features";

/**
 * What the website's server checks as it starts (src/instrumentation.ts):
 *
 * - LOCAL_DB=1 never runs in production: it throws, and the server does not
 *   start.
 * - Without COMMUNITY_HASH_SALT, sessions are signed with the fallback secret
 *   in session.ts, which anyone can read in this public repository: it warns,
 *   loudly. The live service refuses to start without it; the website keeps
 *   its fallback so a development checkout signs in with no setup.
 */
export function checkServerSetup(warn: (message: string) => void = console.warn): void {
  assertLocalDbAllowed();
  if (areOnlineFeaturesEnabled() && !process.env.COMMUNITY_HASH_SALT) {
    warn(
      "[auth] COMMUNITY_HASH_SALT is not set: sessions are signed with the public fallback secret. Set it in production.",
    );
  }
}
