import { PermanentProviderError } from "@reel/core";
import { FETCH_TIMEOUT_MS } from "../download";
import type { PendingStore } from "../pending-store";
import { Semaphore, withRetry } from "../retry";
import { HfHttpError, isAmbiguousSubmitError, isRetryableSubmitError, type HfStatus, type HiggsfieldApi } from "./higgsfield-api";
import type { GenResult, ImageGen, MediaUploader, VideoGen } from "./types";

const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled", "cancelled"]);
export const IMAGE_MAX_WAIT_MS = 10 * 60 * 1000;

type GatewayOpts = { pollMs?: number; submitBaseDelayMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; log?: (m: string) => void };

export class HiggsfieldGateway {
  private readonly semaphore: Semaphore;
  constructor(private readonly api: HiggsfieldApi, private readonly pending: PendingStore, concurrency: number, private readonly opts: GatewayOpts = {}) {
    this.semaphore = new Semaphore(concurrency);
  }

  private readonly inflight = new Map<string, Promise<GenResult>>();

  run(model: string, input: Record<string, unknown>, pick: (r: HfStatus) => string | undefined, run: { resumeKey?: string; maxWaitMs: number }): Promise<GenResult> {
    const key = run.resumeKey;
    if (!key) return this.execute(model, input, pick, run);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.execute(model, input, pick, run).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async execute(model: string, input: Record<string, unknown>, pick: (r: HfStatus) => string | undefined, run: { resumeKey?: string; maxWaitMs: number }): Promise<GenResult> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? Date.now;
    const log = this.opts.log ?? (() => {});
    const bestEffort = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        log(`pending store ${what} failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    return this.semaphore.run(async () => {
      let requestId: string | null = null;
      let fromStore = false;
      let resubmittedAfterUnknown = false;
      const resumed = run.resumeKey ? await this.pending.get(run.resumeKey).catch((err) => { log(`pending store get failed (continuing): ${err instanceof Error ? err.message : String(err)}`); return null; }) : null;
      if (resumed) {
        requestId = resumed.requestId;
        fromStore = true;
        log(`resuming Higgsfield request ${requestId} instead of submitting again`);
      }
      const seenStatuses = new Set<string>();
      for (;;) {
        if (!requestId) {
          try {
            requestId = await withRetry(() => this.api.submit(model, input), {
              attempts: 4,
              baseDelayMs: this.opts.submitBaseDelayMs ?? 5000,
              isTransient: isRetryableSubmitError,
              sleep,
            });
          } catch (err) {
            if (isAmbiguousSubmitError(err)) {
              throw new Error("Higgsfield submit timed out; the job may have been created — check the Higgsfield dashboard before retrying");
            }
            throw err;
          }
          fromStore = false;
          if (run.resumeKey) {
            const rec = { requestId, model, submittedAt: new Date(now()).toISOString() };
            await bestEffort("set", () => this.pending.set(run.resumeKey!, rec));
          }
        }
        // A 404 means "unknown id" only for a stored id, and only once per run.
        const result = await this.waitFor(requestId, run.maxWaitMs, sleep, now, fromStore && !resubmittedAfterUnknown, seenStatuses, log);
        if (result === "unknown") {
          if (run.resumeKey) await bestEffort("delete", () => this.pending.delete(run.resumeKey!));
          requestId = null;
          fromStore = false;
          resubmittedAfterUnknown = true;
          continue;
        }
        if (run.resumeKey) await bestEffort("delete", () => this.pending.delete(run.resumeKey!));
        const status: string = result.status;
        const url = pick(result);
        if (status === "completed" && url) return { url, requestId };
        const reason =
          status === "nsfw" ? "was blocked by content moderation"
          : status === "completed" ? "completed without an output URL"
          : `ended with status "${status}"`;
        throw new PermanentProviderError(`Higgsfield ${model} ${reason} (request ${requestId})`, "higgsfield", requestId);
      }
    });
  }

  private async waitFor(
    requestId: string,
    maxWaitMs: number,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
    notFoundMeansUnknown: boolean,
    seenStatuses: Set<string>,
    log: (m: string) => void,
  ): Promise<HfStatus | "unknown"> {
    const deadline = now() + maxWaitMs;
    for (;;) {
      try {
        const s = await this.api.status(requestId);
        if (TERMINAL.has(s.status)) return s;
        if (!["queued", "in_progress"].includes(s.status) && !seenStatuses.has(s.status)) {
          seenStatuses.add(s.status);
          log(`Higgsfield request ${requestId} reported unexpected status "${s.status}"; still waiting`);
        }
      } catch (err) {
        if (err instanceof HfHttpError && err.status === 404 && notFoundMeansUnknown) return "unknown";
        // Status polling is read-only: tolerate 404 (id not yet visible), 5xx, 429, timeouts and network errors.
        const tolerable = (err instanceof HfHttpError && (err.status >= 500 || err.status === 429 || err.status === 404)) || !(err instanceof HfHttpError);
        if (!tolerable) throw err;
      }
      if (now() >= deadline) {
        throw new PermanentProviderError(
          `Higgsfield request ${requestId} still processing after ${Math.round(maxWaitMs / 60000)} min; retry to pick it up without paying again`,
          "higgsfield",
          requestId,
        );
      }
      await sleep(this.opts.pollMs ?? 5000);
    }
  }
}

export class HiggsfieldImageGen implements ImageGen {
  constructor(private readonly gateway: HiggsfieldGateway, readonly model = "higgsfield-ai/soul/v2/standard") {}
  generate({ prompt, resumeKey }: { prompt: string; resumeKey?: string }): Promise<GenResult> {
    return this.gateway.run(this.model, { prompt, aspect_ratio: "9:16", resolution: "1080p", batch_size: 1 }, (r) => r.images?.[0]?.url, { resumeKey, maxWaitMs: IMAGE_MAX_WAIT_MS });
  }
}

export class HiggsfieldVideoGen implements VideoGen {
  constructor(
    private readonly gateway: HiggsfieldGateway,
    readonly model = "bytedance/seedance-2.5/image-to-video",
    readonly resolution: "480p" | "720p" | "1080p" = "720p",
    private readonly maxWaitMs = 40 * 60 * 1000,
  ) {}
  async imageToVideo({ imageUrl, prompt, durationSec, resumeKey }: { imageUrl: string; prompt: string; durationSec: number; resumeKey?: string }): Promise<GenResult> {
    if (!Number.isInteger(durationSec) || durationSec < 4 || durationSec > 30) {
      throw new RangeError(`durationSec must be an integer from 4 to 30, got ${durationSec}`);
    }
    return this.gateway.run(
      this.model,
      { image_url: imageUrl, prompt, duration: durationSec, resolution: this.resolution, generate_audio: false },
      (r) => r.video?.url,
      { resumeKey, maxWaitMs: this.maxWaitMs },
    );
  }
}

/** The v2 SDK has no upload helper; this implements the documented two-step upload. */
export class HiggsfieldUploader implements MediaUploader {
  constructor(
    private readonly credentials: string,
    private readonly baseUrl = "https://api.higgsfield.ai",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upload(data: Buffer, contentType: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/files/generate-upload-url`, {
      method: "POST",
      headers: { Authorization: `Key ${this.credentials}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: contentType }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Higgsfield upload URL request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { upload_url: string; public_url: string; upload_headers?: Record<string, string> };
    const put = await this.fetchImpl(body.upload_url, {
      method: "PUT",
      headers: body.upload_headers ?? { "Content-Type": contentType },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!put.ok) throw new Error(`Higgsfield upload PUT failed: HTTP ${put.status}`);
    return body.public_url;
  }
}
