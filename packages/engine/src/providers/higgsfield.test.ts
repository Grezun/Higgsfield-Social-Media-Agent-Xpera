import { BadInputError, NotEnoughCreditsError, type V2Response } from "@higgsfield/client/v2";
import { PermanentProviderError } from "@reel/core";
import { describe, expect, it, vi } from "vitest";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen, isTransientHiggsfieldError } from "./higgsfield";

const done = (extra: Partial<V2Response>): V2Response => ({
  status: "completed", request_id: "req-1", status_url: "", cancel_url: "", ...extra,
});
const noSleep = async () => {};

describe("HiggsfieldImageGen", () => {
  it("requests a single 9:16 1080p image and returns its URL", async () => {
    const subscribe = vi.fn(async () => done({ images: [{ url: "https://cdn/img.png" }] }));
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 4, { sleep: noSleep }));
    expect(await gen.generate({ prompt: "a cat" })).toEqual({ url: "https://cdn/img.png", requestId: "req-1" });
    expect(subscribe).toHaveBeenCalledWith("higgsfield-ai/soul/v2/standard", {
      prompt: "a cat", aspect_ratio: "9:16", resolution: "1080p", batch_size: 1,
    });
  });

  it("turns nsfw into a PermanentProviderError carrying the request id", async () => {
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(async () => done({ status: "nsfw" }), 1, { sleep: noSleep }));
    const err = await gen.generate({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/content moderation/);
    expect(err.requestId).toBe("req-1");
  });
});

describe("HiggsfieldVideoGen", () => {
  it("sends image-to-video with audio disabled", async () => {
    const subscribe = vi.fn(async () => done({ video: { url: "https://cdn/v.mp4" } }));
    const gen = new HiggsfieldVideoGen(new HiggsfieldGateway(subscribe, 1, { sleep: noSleep }), undefined, "720p");
    await gen.imageToVideo({ imageUrl: "https://cdn/i.png", prompt: "push in", durationSec: 5 });
    expect(subscribe).toHaveBeenCalledWith("bytedance/seedance-2.5/image-to-video", {
      image_url: "https://cdn/i.png", prompt: "push in", duration: 5, resolution: "720p", generate_audio: false,
    });
  });

  it("rejects durations outside 4–30 integer seconds before calling the API", async () => {
    const subscribe = vi.fn();
    const gen = new HiggsfieldVideoGen(new HiggsfieldGateway(subscribe, 1));
    await expect(gen.imageToVideo({ imageUrl: "u", prompt: "p", durationSec: 3 })).rejects.toThrow(RangeError);
    await expect(gen.imageToVideo({ imageUrl: "u", prompt: "p", durationSec: 5.5 })).rejects.toThrow(RangeError);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("HiggsfieldGateway retries", () => {
  it("retries the concurrency-limit 400 instead of failing the scene", async () => {
    let calls = 0;
    const subscribe = async () => {
      calls++;
      if (calls < 3) throw new BadInputError("Maximum number of concurrent requests reached");
      return done({ images: [{ url: "https://cdn/ok.png" }] });
    };
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 1, { sleep: noSleep }));
    expect((await gen.generate({ prompt: "x" })).url).toBe("https://cdn/ok.png");
    expect(calls).toBe(3);
  });

  it("does not retry when credits run out", async () => {
    let calls = 0;
    const subscribe = async () => {
      calls++;
      throw new NotEnoughCreditsError();
    };
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 1, { sleep: noSleep }));
    await expect(gen.generate({ prompt: "x" })).rejects.toBeInstanceOf(NotEnoughCreditsError);
    expect(calls).toBe(1);
  });

  it("classifies errors", () => {
    expect(isTransientHiggsfieldError(new BadInputError("Maximum number of concurrent requests"))).toBe(true);
    expect(isTransientHiggsfieldError(new BadInputError("prompt: field required"))).toBe(false);
    expect(isTransientHiggsfieldError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(false);
  });

  it("detects concurrent limit from BadInputError details array", () => {
    const err = new BadInputError([{ type: "value_error", loc: ["body"], msg: "Maximum number of concurrent requests reached" }]);
    expect(isTransientHiggsfieldError(err)).toBe(true);
  });

  it("limits concurrent requests to the account limit", async () => {
    let active = 0;
    let peak = 0;
    const subscribe = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return done({ images: [{ url: "https://cdn/x.png" }] });
    };
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(subscribe, 2, { sleep: noSleep }));
    await Promise.all(Array.from({ length: 6 }, () => gen.generate({ prompt: "p" })));
    expect(peak).toBe(2);
  });

  it("converts status 'failed' to PermanentProviderError with request id", async () => {
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(async () => done({ status: "failed" }), 1, { sleep: noSleep }));
    const err = await gen.generate({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/ended with status "failed"/);
    expect(err.requestId).toBe("req-1");
  });

  it("detects completed without output URL", async () => {
    const gen = new HiggsfieldImageGen(new HiggsfieldGateway(async () => done({ images: [] }), 1, { sleep: noSleep }));
    const err = await gen.generate({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/completed without an output URL/);
    expect(err.requestId).toBe("req-1");
  });

  it("converts status 'canceled' to PermanentProviderError with request id", async () => {
    const gen = new HiggsfieldImageGen(
      new HiggsfieldGateway(async () => done({ status: "canceled" as V2Response["status"] }), 1, { sleep: noSleep }),
    );
    const err = await gen.generate({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/ended with status "canceled"/);
    expect(err.requestId).toBe("req-1");
  });
});

describe("HiggsfieldUploader", () => {
  it("gets an upload URL, PUTs the bytes and returns the public URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/files/generate-upload-url")) {
        return Response.json({ upload_url: "https://upload/put", public_url: "https://cdn/public.png" });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const uploader = new HiggsfieldUploader("id:secret", "https://api.higgsfield.ai", fakeFetch);
    expect(await uploader.upload(Buffer.from("png"), "image/png")).toBe("https://cdn/public.png");
    expect(calls[0].url).toBe("https://api.higgsfield.ai/files/generate-upload-url");
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Key id:secret");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ content_type: "image/png" });
    expect(calls[1]).toMatchObject({ url: "https://upload/put", init: { method: "PUT" } });
  });

  it("fails loudly when the PUT fails", async () => {
    const fakeFetch = (async (url: string) =>
      url.endsWith("generate-upload-url")
        ? Response.json({ upload_url: "https://upload/put", public_url: "https://cdn/p.png" })
        : new Response(null, { status: 500 })) as typeof fetch;
    await expect(new HiggsfieldUploader("a:b", undefined, fakeFetch).upload(Buffer.from("x"), "image/png")).rejects.toThrow(
      /upload PUT failed: HTTP 500/,
    );
  });
});
