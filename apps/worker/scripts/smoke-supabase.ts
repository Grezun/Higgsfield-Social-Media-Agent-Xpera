import { BUCKETS, type Database } from "@reel/db";
import { loadEnvFile } from "@reel/engine";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkerEnv } from "../src/env";
import { SupabaseJobQueue } from "../src/queue";
import { SupabaseBlobStore } from "../src/storage";

// Free check of the hosted project: queue functions, stale requeue and storage round trip. Cleans up after itself,
// even on failure: nothing here calls process.exit while cleanup is pending.
class SmokeFailure extends Error {}
const fail = (msg: string): never => {
  throw new SmokeFailure(msg);
};
const pass = (msg: string) => console.log(`PASS ${msg}`);

loadEnvFile();
const env = loadWorkerEnv(process.env, []);
const sb = createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const queue = new SupabaseJobQueue(sb, "smoke");

let projectId: string | undefined;
let jobId: string | undefined;
let objectName: string | undefined;
let strayJob: { id: string } | undefined;
let failed = false;

const cleanupFailed = (what: string, message: string | undefined) => {
  console.error(`CLEANUP FAILED ${what}: ${message}`);
  process.exitCode = 1;
  failed = true;
};

async function cleanup() {
  if (objectName) {
    const { error } = await sb.storage.from(BUCKETS.assets).remove([objectName]);
    if (error) cleanupFailed("storage remove", error.message);
  }
  if (strayJob) {
    const { data, error: readError } = await sb.from("jobs").select("attempts").eq("id", strayJob.id).single();
    if (readError || !data) cleanupFailed("read stray job", readError?.message);
    else {
      const { error } = await sb.from("jobs").update({ status: "queued", locked_by: null, attempts: Math.max(0, data.attempts - 1) }).eq("id", strayJob.id).eq("locked_by", "smoke");
      if (error) cleanupFailed("release stray job", error.message);
    }
  }
  if (jobId) {
    const { error } = await sb.from("jobs").delete().eq("id", jobId);
    if (error) cleanupFailed("delete job", error.message);
  }
  if (projectId) {
    const { error } = await sb.from("projects").delete().eq("id", projectId);
    if (error) cleanupFailed("delete project", error.message);
  }
}

try {
  const { count: queued } = await sb.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued");
  if (queued) fail(`${queued} real job(s) are queued; stop and retry when the queue is empty so this check doesn't claim them`);

  const { data: users, error: usersError } = await sb.auth.admin.listUsers({ perPage: 1 });
  if (usersError) fail(`auth admin: ${usersError.message}`);
  const owner = users!.users[0] ?? fail("no users yet: invite yourself first (Dashboard → Authentication → Users → Invite user)");

  const { data: project, error: projectError } = await sb.from("projects").insert({ owner_id: owner.id, title: "smoke test", language: "en" }).select("id").single();
  if (projectError || !project) fail(`insert project: ${projectError?.message}`);
  projectId = project!.id;
  pass("insert project");

  const { data: job, error: jobError } = await sb.from("jobs").insert({ project_id: projectId!, type: "plan", payload: {}, created_by: owner.id }).select("id").single();
  if (jobError || !job) fail(`insert job: ${jobError?.message}`);
  jobId = job!.id;

  const claimed = await queue.claim("smoke");
  if (claimed && claimed.id !== jobId) {
    strayJob = { id: claimed.id };
    fail("claimed a real job by accident; released it");
  }
  if (claimed?.status !== "running" || claimed.attempts !== 1) fail(`claim_job returned ${JSON.stringify(claimed)}`);
  pass("claim_job claims the queued job");
  const second = await queue.claim("smoke");
  if (second) {
    if (second.id !== jobId) strayJob = { id: second.id };
    fail("claim_job returned a second job");
  }
  pass("claim_job returns nothing when the queue is empty");

  if (!(await queue.heartbeat(jobId!))) fail("heartbeat did not update the running job");
  const { error: ageError } = await sb.from("jobs").update({ heartbeat_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", jobId!);
  if (ageError) fail(`age heartbeat: ${ageError.message}`);
  if ((await queue.requeueStale(120)) < 1) fail("requeue_stale_jobs did not requeue the stale job");
  const reclaimed = await queue.claim("smoke");
  if (reclaimed && reclaimed.id !== jobId) {
    strayJob = { id: reclaimed.id };
    fail("claimed a real job by accident; released it");
  }
  if (reclaimed?.attempts !== 2) fail(`reclaim returned ${JSON.stringify(reclaimed)}`);
  pass("stale job requeued and reclaimed (attempt 2)");

  if (!(await queue.finish(jobId!, { status: "done", progress: { steps: { voice: "done" }, scenes: {} } }))) fail("finish did not update the job");
  const { data: finished } = await sb.from("jobs").select("status, finished_at, progress").eq("id", jobId!).single();
  if (finished?.status !== "done" || !finished.finished_at) fail(`finish wrote ${JSON.stringify(finished)}`);
  pass("finish marks the job done");

  const dir = await mkdtemp(join(tmpdir(), "smoke-"));
  const name = `smoke-${randomUUID()}.txt`;
  await writeFile(join(dir, "up.txt"), "hello storage");
  const blobs = new SupabaseBlobStore(sb);
  objectName = name;
  await blobs.upload(BUCKETS.assets, name, join(dir, "up.txt"), "text/plain");
  await blobs.download(BUCKETS.assets, name, join(dir, "down.txt"));
  if ((await readFile(join(dir, "down.txt"), "utf8")) !== "hello storage") fail("storage round trip mismatch");
  pass("storage upload/download round trip");
} catch (err) {
  failed = true;
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
if (!failed) console.log("All Supabase checks passed.");
