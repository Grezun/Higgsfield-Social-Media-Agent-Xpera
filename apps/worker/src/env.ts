import { hostname } from "node:os";

export type WorkerEnv = {
  supabaseUrl: string;
  supabaseSecretKey: string;
  workerId: string;
  pollMs: number;
  providers: "real" | "fake";
};

export function loadWorkerEnv(env: NodeJS.ProcessEnv, argv: string[]): WorkerEnv {
  const missing = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing in .env.local: ${missing.join(", ")}`);
  const pollMs = Number(env.WORKER_POLL_MS ?? "3000");
  if (!Number.isInteger(pollMs) || pollMs < 250) throw new Error(`WORKER_POLL_MS must be an integer ≥ 250 (got "${env.WORKER_POLL_MS}")`);
  return {
    supabaseUrl: env.SUPABASE_URL!,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY!,
    workerId: env.WORKER_ID || `${hostname()}-${process.pid}`,
    pollMs,
    providers: argv.includes("--fake") ? "fake" : "real",
  };
}
