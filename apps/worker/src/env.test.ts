import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env";

describe("loadWorkerEnv", () => {
  it("requires the Supabase URL and secret key", () => {
    expect(() => loadWorkerEnv({}, [])).toThrow(/SUPABASE_URL, SUPABASE_SECRET_KEY/);
  });
  it("applies defaults and reads --fake", () => {
    const env = loadWorkerEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" }, ["--fake"]);
    expect(env).toMatchObject({ supabaseUrl: "https://x.supabase.co", pollMs: 3000, providers: "fake" });
    expect(env.workerId).toMatch(/-\d+$/);
  });
  it("rejects a silly poll interval", () => {
    expect(() => loadWorkerEnv({ SUPABASE_URL: "u", SUPABASE_SECRET_KEY: "k", WORKER_POLL_MS: "10" }, [])).toThrow(/WORKER_POLL_MS/);
  });
});
