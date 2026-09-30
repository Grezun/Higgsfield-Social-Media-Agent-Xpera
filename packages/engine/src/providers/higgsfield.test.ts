import { PermanentProviderError } from "@reel/core";
import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStore, type PendingStore } from "../pending-store";
import { HfHttpError, httpHiggsfieldApi, isRetryableSubmitError, type HfStatus, type HiggsfieldApi } from "./higgsfield-api";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen } from "./higgsfield";

const noSleep = async () => {};
const IMG = "higgsfield-ai/soul/v2/standard";
const inProgress = async (): Promise<HfStatus> => ({ status: "in_progress", request_id: "req-1" });
const completedImg = (id = "req-1", url = "https://cdn/img.png") => async (): Promise<HfStatus> => ({ status: "completed", request_id: id, images: [{ url }] });
const withStatus = (status: string, id = "req-1") => async (): Promise<HfStatus> => ({ status, request_id: id });

function fakeApi(script: { submit?: (() => Promise<string>)[]; statuses?: Record<string, (() => Promise<HfStatus>)[]> }) {
  const calls = { submit: 0, status: 0 };
  const inputs: { model: string; input: Record<string, unknown> }[] = [];
  const api: HiggsfieldApi = {
    async submit(model, input) { calls.submit++; inputs.push({ model, input }); const next = script.submit?.shift(); return next ? next() : "req-1"; },
    async status(id) { calls.status++; const q = script.statuses?.[id]; const next = q?.shift(); if (!next) throw new Error(`no scripted status for ${id}`); return next(); },
  };
  return { api, calls, inputs };
}

const make = (api: HiggsfieldApi, pending = new MemoryPendingStore(), concurrency = 4, opts: ConstructorParameters<typeof HiggsfieldGateway>[3] = {}) =>
  new HiggsfieldGateway(api, pending, concurrency, { sleep: noSleep, ...opts });

describe("HiggsfieldImageGen", () => {
  it("submits a single 9:16 1080p image, polls, and returns url + request id", async () => {
    const { api, calls, inputs } = fakeApi({ statuses: { "req-1": [inProgress, completedImg()] } });
    const pending = new MemoryPendingStore();
    const gen = new HiggsfieldImageGen(make(api, pending));
    expect(await gen.generate({ prompt: "a cat", resumeKey: "k" })).toEqual({ url: "https://cdn/img.png", requestId: "req-1" });
    expect(inputs).toEqual([{ model: IMG, input: { prompt: "a cat", aspect_ratio: "9:16", resolution: "1080p", batch_size: 1 } }]);
    expect(calls.submit).toBe(1);
    expect(pending.records.size).toBe(0);
  });
});

describe("HiggsfieldVideoGen", () => {
  it("sends image-to-video with audio disabled", async () => {
    const { api, inputs } = fakeApi({ statuses: { "req-1": [async () => ({ status: "completed", request_id: "req-1", video: { url: "https://cdn/v.mp4" } })] } });
    const gen = new HiggsfieldVideoGen(make(api, undefined, 1), undefined, "720p");
    expect((await gen.imageToVideo({ imageUrl: "https://cdn/i.png", prompt: "push in", durationSec: 5 })).url).toBe("https://cdn/v.mp4");
    expect(inputs[0]).toEqual({
      model: "bytedance/seedance-2.5/image-to-video",
      input: { image_url: "https://cdn/i.png", prompt: "push in", duration: 5, resolution: "720p", generate_audio: false },
    });
  });

  it("rejects durations outside 4-30 integer seconds before calling the API", async () => {
    const { api, calls } = fakeApi({});
    const gen = new HiggsfieldVideoGen(make(api, undefined, 1));
    await expect(gen.imageToVideo({ imageUrl: "u", prompt: "p", durationSec: 3 })).rejects.toThrow(RangeError);
    await expect(gen.imageToVideo({ imageUrl: "u", prompt: "p", durationSec: 5.5 })).rejects.toThrow(RangeError);
    expect(calls.submit).toBe(0);
  });
});

describe("HiggsfieldGateway submit", () => {
  it("retries a 502 submit and uses the eventual request id", async () => {
    const { api, calls } = fakeApi({
      submit: [async () => { throw new HfHttpError(502, "bad gateway"); }, async () => { throw new HfHttpError(502, "bad gateway"); }, async () => "req-2"],
      statuses: { "req-2": [completedImg("req-2")] },
    });
    const res = await new HiggsfieldImageGen(make(api)).generate({ prompt: "x" });
    expect(calls.submit).toBe(3);
    expect(res.requestId).toBe("req-2");
  });

  it("does not retry a 422 submit", async () => {
    const { api, calls } = fakeApi({ submit: [async () => { throw new HfHttpError(422, "bad input"); }] });
    await expect(new HiggsfieldImageGen(make(api)).generate({ prompt: "x" })).rejects.toBeInstanceOf(HfHttpError);
    expect(calls.submit).toBe(1);
  });

  it("retries the concurrency-limit 400", async () => {
    const { api, calls } = fakeApi({
      submit: [async () => { throw new HfHttpError(400, "Maximum number of concurrent requests reached"); }],
      statuses: { "req-1": [completedImg()] },
    });
    await new HiggsfieldImageGen(make(api)).generate({ prompt: "x" });
    expect(calls.submit).toBe(2);
  });
});

describe("HiggsfieldGateway polling and resume", () => {
  it("tolerates 5xx and network errors while polling without re-submitting", async () => {
    const { api, calls } = fakeApi({
      statuses: { "req-1": [
        async () => { throw new HfHttpError(502, "bad gateway"); },
        async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
        completedImg(),
      ] },
    });
    const res = await new HiggsfieldImageGen(make(api)).generate({ prompt: "x" });
    expect(res.requestId).toBe("req-1");
    expect(calls.submit).toBe(1);
  });

  it("on timeout throws a permanent error but keeps the pending record", async () => {
    let t = 0;
    const { api } = fakeApi({ statuses: { "req-1": Array.from({ length: 50 }, () => inProgress) } });
    const pending = new MemoryPendingStore();
    const gw = make(api, pending, 1, { now: () => t, sleep: async (ms) => { t += ms; } });
    const err = await gw.run(IMG, {}, (r) => r.images?.[0]?.url, { resumeKey: "k", maxWaitMs: 60_000 * 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/still processing after \d+ min.*retry to pick it up/);
    expect(err.requestId).toBe("req-1");
    expect(await pending.get("k")).toMatchObject({ requestId: "req-1" });
  });

  it("resumes a stored request id with zero submits and clears the record", async () => {
    const { api, calls } = fakeApi({ statuses: { "req-9": [completedImg("req-9")] } });
    const pending = new MemoryPendingStore();
    await pending.set("k", { requestId: "req-9", model: IMG, submittedAt: "2026-10-01T00:00:00.000Z" });
    const res = await new HiggsfieldImageGen(make(api, pending)).generate({ prompt: "x", resumeKey: "k" });
    expect(res.requestId).toBe("req-9");
    expect(calls.submit).toBe(0);
    expect(pending.records.size).toBe(0);
  });

  it("forgets an id the provider does not know (404) and submits fresh", async () => {
    const { api, calls } = fakeApi({
      statuses: { "req-9": [async () => { throw new HfHttpError(404, "not found"); }], "req-1": [completedImg()] },
    });
    const pending = new MemoryPendingStore();
    await pending.set("k", { requestId: "req-9", model: IMG, submittedAt: "2026-10-01T00:00:00.000Z" });
    const res = await new HiggsfieldImageGen(make(api, pending)).generate({ prompt: "x", resumeKey: "k" });
    expect(res.requestId).toBe("req-1");
    expect(calls.submit).toBe(1);
    expect(pending.records.size).toBe(0);
  });

  it("tolerates 404 on an id this run submitted itself (no resubmit)", async () => {
    const { api, calls } = fakeApi({
      statuses: { "req-1": [async () => { throw new HfHttpError(404, "nf"); }, async () => { throw new HfHttpError(404, "nf"); }, completedImg()] },
    });
    const res = await new HiggsfieldImageGen(make(api)).generate({ prompt: "x", resumeKey: "k" });
    expect(res.requestId).toBe("req-1");
    expect(calls.submit).toBe(1);
  });

  it("resubmits at most once when a resumed id is unknown", async () => {
    const nf = async (): Promise<HfStatus> => { throw new HfHttpError(404, "nf"); };
    const { api, calls } = fakeApi({ statuses: { "req-9": [nf], "req-1": [nf, nf, nf, completedImg()] } });
    const pending = new MemoryPendingStore();
    await pending.set("k", { requestId: "req-9", model: IMG, submittedAt: "2026-10-01T00:00:00.000Z" });
    const res = await new HiggsfieldImageGen(make(api, pending)).generate({ prompt: "x", resumeKey: "k" });
    expect(res.requestId).toBe("req-1");
    expect(calls.submit).toBe(1);
  });

  it("dedupes concurrent runs with the same resumeKey", async () => {
    const { api, calls } = fakeApi({ statuses: { "req-1": [inProgress, completedImg()] } });
    const gen = new HiggsfieldImageGen(make(api));
    const [a, b] = await Promise.all([gen.generate({ prompt: "x", resumeKey: "k" }), gen.generate({ prompt: "x", resumeKey: "k" })]);
    expect(calls.submit).toBe(1);
    expect(a.url).toBe(b.url);
  });

  it("pending store failures are best-effort", async () => {
    const boom = async () => { throw new Error("disk full"); };
    const store: PendingStore = { get: async () => null, set: boom, delete: boom };
    const logs: string[] = [];
    const { api, calls } = fakeApi({ statuses: { "req-1": [completedImg()] } });
    const res = await new HiggsfieldImageGen(make(api, store as unknown as MemoryPendingStore, 1, { log: (m) => logs.push(m) })).generate({ prompt: "x", resumeKey: "k" });
    expect(res.requestId).toBe("req-1");
    expect(calls.submit).toBe(1);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("does not retry an ambiguous submit timeout", async () => {
    const { api, calls } = fakeApi({ submit: [async () => { throw new HfHttpError(504, "gateway timeout"); }] });
    const err = await new HiggsfieldImageGen(make(api)).generate({ prompt: "x" }).catch((e) => e);
    expect(err.message).toMatch(/submit timed out; the job may have been created/);
    expect(err).not.toBeInstanceOf(PermanentProviderError);
    expect(calls.submit).toBe(1);
    const t = fakeApi({ submit: [async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }] });
    await expect(new HiggsfieldImageGen(make(t.api)).generate({ prompt: "x" })).rejects.toThrow(/job may have been created/);
    expect(t.calls.submit).toBe(1);
  });

  it("logs unexpected non-terminal statuses once", async () => {
    const logs: string[] = [];
    const weird = async (): Promise<HfStatus> => ({ status: "weird", request_id: "req-1" });
    const { api } = fakeApi({ statuses: { "req-1": [weird, weird, completedImg()] } });
    await new HiggsfieldImageGen(make(api, undefined, 1, { log: (m) => logs.push(m) })).generate({ prompt: "x" });
    expect(logs.filter((l) => /weird/.test(l))).toHaveLength(1);
  });

  it("terminal failure clears pending so the next run submits fresh", async () => {
    const { api, calls } = fakeApi({ statuses: { "req-1": [withStatus("failed"), completedImg()] } });
    const pending = new MemoryPendingStore();
    const gen = new HiggsfieldImageGen(make(api, pending));
    const err = await gen.generate({ prompt: "x", resumeKey: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/ended with status "failed"/);
    expect(err.requestId).toBe("req-1");
    expect(pending.records.size).toBe(0);
    await gen.generate({ prompt: "x", resumeKey: "k" });
    expect(calls.submit).toBe(2);
  });

  it("turns nsfw into a content moderation error", async () => {
    const { api } = fakeApi({ statuses: { "req-1": [withStatus("nsfw")] } });
    const err = await new HiggsfieldImageGen(make(api)).generate({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentProviderError);
    expect(err.message).toMatch(/content moderation/);
  });

  it("detects completed without output URL and canceled", async () => {
    const a = fakeApi({ statuses: { "req-1": [async () => ({ status: "completed", request_id: "req-1", images: [] })] } });
    await expect(new HiggsfieldImageGen(make(a.api)).generate({ prompt: "x" })).rejects.toThrow(/completed without an output URL/);
    const b = fakeApi({ statuses: { "req-1": [withStatus("canceled")] } });
    await expect(new HiggsfieldImageGen(make(b.api)).generate({ prompt: "x" })).rejects.toThrow(/ended with status "canceled"/);
  });

  it("limits in-flight runs to the concurrency", async () => {
    let active = 0;
    let peak = 0;
    const api: HiggsfieldApi = {
      async submit() { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); return "req-1"; },
      async status() { active--; return { status: "completed", request_id: "req-1", images: [{ url: "https://cdn/x.png" }] }; },
    };
    const gen = new HiggsfieldImageGen(make(api, undefined, 2));
    await Promise.all(Array.from({ length: 6 }, () => gen.generate({ prompt: "p" })));
    expect(peak).toBe(2);
  });
});

describe("httpHiggsfieldApi", () => {
  it("POSTs the submit with auth and returns request_id", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "queued", request_id: "req-1" }));
    const api = httpHiggsfieldApi("id:secret", "https://api.higgsfield.ai", fetchImpl as unknown as typeof fetch);
    expect(await api.submit(IMG, { prompt: "a" })).toBe("req-1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Key id:secret");
    expect(JSON.parse(init.body as string)).toEqual({ prompt: "a" });
  });

  it("strips trailing slashes from baseUrl and sends a User-Agent", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "in_progress", request_id: "r" }));
    await httpHiggsfieldApi("a:b", "https://api.higgsfield.ai//", fetchImpl as unknown as typeof fetch).status("r");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.higgsfield.ai/requests/r/status");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("reel-agent/1.0");
  });

  it("GETs status from /requests/{id}/status", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "in_progress", request_id: "req-1" }));
    const api = httpHiggsfieldApi("id:secret", "https://api.higgsfield.ai", fetchImpl as unknown as typeof fetch);
    expect((await api.status("req-1")).status).toBe("in_progress");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.higgsfield.ai/requests/req-1/status");
  });

  it("throws HfHttpError with the status on non-OK", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const err = await httpHiggsfieldApi("a:b", undefined, fetchImpl).status("r").catch((e) => e);
    expect(err).toBeInstanceOf(HfHttpError);
    expect(err.status).toBe(503);
  });

  it("classifies retryable submit errors", () => {
    expect(isRetryableSubmitError(new HfHttpError(502, "x"))).toBe(true);
    expect(isRetryableSubmitError(new HfHttpError(429, "x"))).toBe(true);
    expect(isRetryableSubmitError(new HfHttpError(400, "Maximum number of concurrent requests"))).toBe(true);
    expect(isRetryableSubmitError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableSubmitError(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe(true);
    expect(isRetryableSubmitError(Object.assign(new Error("ct"), { code: "UND_ERR_CONNECT_TIMEOUT" }))).toBe(true);
    expect(isRetryableSubmitError(new HfHttpError(504, "x"))).toBe(false);
    expect(isRetryableSubmitError(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(false);
    expect(isRetryableSubmitError(new HfHttpError(422, "x"))).toBe(false);
    expect(isRetryableSubmitError(new HfHttpError(400, "prompt required"))).toBe(false);
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

  it("passes an AbortSignal on both requests so a stalled upload cannot hang", async () => {
    const signals: unknown[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return url.endsWith("generate-upload-url")
        ? Response.json({ upload_url: "https://upload/put", public_url: "https://cdn/p.png" })
        : new Response(null, { status: 200 });
    }) as typeof fetch;
    await new HiggsfieldUploader("a:b", undefined, fakeFetch).upload(Buffer.from("x"), "image/png");
    expect(signals).toHaveLength(2);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
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
