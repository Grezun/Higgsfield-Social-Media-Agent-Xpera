import {
  APIError,
  BadInputError,
  createHiggsfieldClient,
  NotEnoughCreditsError,
  type V2Response,
} from "@higgsfield/client/v2";
import { PermanentProviderError } from "@reel/core";
import { Semaphore, withRetry } from "../retry";
import type { GenResult, ImageGen, MediaUploader, VideoGen } from "./types";

export type SubscribeFn = (endpoint: string, input: Record<string, unknown>) => Promise<V2Response>;

export function sdkSubscribe(credentials: string): SubscribeFn {
  // Video generation can take several minutes; the SDK default poll limit is 5.
  const client = createHiggsfieldClient({ credentials, maxPollTime: 15 * 60 * 1000 });
  return (endpoint, input) => client.subscribe(endpoint, { input, withPolling: true });
}

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"]);

export function isTransientHiggsfieldError(err: unknown): boolean {
  if (err instanceof NotEnoughCreditsError) return false;
  // The per-account concurrency limit surfaces as HTTP 400 "Maximum number of concurrent requests…".
  if (err instanceof BadInputError) return /concurrent/i.test(`${err.message} ${JSON.stringify(err.responseData ?? "")}`);
  if (err instanceof APIError) return err.statusCode === 429 || (err.statusCode ?? 0) >= 500;
  return NETWORK_CODES.has((err as { code?: string } | null)?.code ?? "");
}

export class HiggsfieldGateway {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly subscribe: SubscribeFn,
    concurrency: number,
    private readonly opts: { baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.semaphore = new Semaphore(concurrency);
  }

  async run(endpoint: string, input: Record<string, unknown>, pick: (r: V2Response) => string | undefined): Promise<GenResult> {
    const result = await this.semaphore.run(() =>
      withRetry(() => this.subscribe(endpoint, input), {
        attempts: 4,
        baseDelayMs: this.opts.baseDelayMs ?? 5000,
        isTransient: isTransientHiggsfieldError,
        sleep: this.opts.sleep,
      }),
    );
    // The SDK types omit "canceled", which the API can also return; compare as a plain string.
    const status: string = result.status;
    const url = pick(result);
    if (status === "completed" && url) return { url, requestId: result.request_id };
    const reason =
      status === "nsfw" ? "was blocked by content moderation"
      : status === "completed" ? "completed without an output URL"
      : `ended with status "${status}"`;
    throw new PermanentProviderError(`Higgsfield ${endpoint} ${reason}`, "higgsfield", result.request_id);
  }
}

export class HiggsfieldImageGen implements ImageGen {
  constructor(private readonly gateway: HiggsfieldGateway, readonly model = "higgsfield-ai/soul/v2/standard") {}

  generate({ prompt }: { prompt: string }): Promise<GenResult> {
    return this.gateway.run(this.model, { prompt, aspect_ratio: "9:16", resolution: "1080p", batch_size: 1 }, (r) => r.images?.[0]?.url);
  }
}

export class HiggsfieldVideoGen implements VideoGen {
  constructor(
    private readonly gateway: HiggsfieldGateway,
    readonly model = "bytedance/seedance-2.5/image-to-video",
    private readonly resolution: "480p" | "720p" | "1080p" = "720p",
  ) {}

  async imageToVideo({ imageUrl, prompt, durationSec }: { imageUrl: string; prompt: string; durationSec: number }): Promise<GenResult> {
    if (!Number.isInteger(durationSec) || durationSec < 4 || durationSec > 30) {
      throw new RangeError(`durationSec must be an integer from 4 to 30, got ${durationSec}`);
    }
    return this.gateway.run(
      this.model,
      { image_url: imageUrl, prompt, duration: durationSec, resolution: this.resolution, generate_audio: false },
      (r) => r.video?.url,
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
    });
    if (!res.ok) throw new Error(`Higgsfield upload URL request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { upload_url: string; public_url: string; upload_headers?: Record<string, string> };
    const put = await this.fetchImpl(body.upload_url, {
      method: "PUT",
      headers: body.upload_headers ?? { "Content-Type": contentType },
      body: new Uint8Array(data),
    });
    if (!put.ok) throw new Error(`Higgsfield upload PUT failed: HTTP ${put.status}`);
    return body.public_url;
  }
}
