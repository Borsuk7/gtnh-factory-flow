import { afterEach, describe, expect, it, vi } from "vitest";
import { checkServerSetup } from "./startup-checks";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the server's startup checks", () => {
  it("refuse the local database in production", () => {
    vi.stubEnv("COMMUNITY_HASH_SALT", "set");
    vi.stubEnv("LOCAL_DB", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => checkServerSetup(() => undefined)).toThrow(/LOCAL_DB=1/);
    vi.stubEnv("NODE_ENV", "development");
    expect(() => checkServerSetup(() => undefined)).not.toThrow();
  });

  it("warn when sessions would be signed with the fallback secret", () => {
    vi.stubEnv("LOCAL_DB", "");
    const warnings: string[] = [];
    vi.stubEnv("COMMUNITY_HASH_SALT", "");
    checkServerSetup((message) => warnings.push(message));
    expect(warnings).toEqual([expect.stringMatching(/COMMUNITY_HASH_SALT is not set/)]);
    vi.stubEnv("COMMUNITY_HASH_SALT", "a real secret");
    checkServerSetup((message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
  });

  it("starts without an auth secret when online features are disabled", () => {
    vi.stubEnv("LOCAL_DB", "");
    vi.stubEnv("COMMUNITY_HASH_SALT", "");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_ONLINE_FEATURES", "false");
    const warn = vi.fn();
    checkServerSetup(warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
