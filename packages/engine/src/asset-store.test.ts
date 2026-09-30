import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { FileAssetStore } from "./asset-store";
import { contentTypeFor, downloadTo, extFromUrl } from "./download";

describe("FileAssetStore", () => {
  it("stores a file with metadata and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-"));
    const src = join(dir, "src.png");
    await writeFile(src, "png-bytes");
    const store = new FileAssetStore(join(dir, "cache"));
    expect(await store.get("abc")).toBeNull();
    const put = await store.putFile("abc", src, "png", { kind: "image", provider: "higgsfield", model: "m", requestId: "r1" });
    expect(put.fileName).toBe("abc.png");
    const got = await store.get("abc");
    expect(got).toMatchObject({ hash: "abc", fileName: "abc.png", meta: { kind: "image", provider: "higgsfield", requestId: "r1" } });
    expect(got!.meta.createdAt).toMatch(/^\d{4}-/);
  });

  it("treats metadata without its file as a miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-"));
    const src = join(dir, "a.wav");
    await writeFile(src, "x");
    const store = new FileAssetStore(join(dir, "cache"));
    await store.putFile("h", src, "wav", { kind: "audio", provider: "p" });
    await rm(join(dir, "cache", "h.wav"));
    expect(await store.get("h")).toBeNull();
  });
});

describe("FileAssetStore corruption", () => {
  it("treats truncated metadata JSON as a miss and recovers on the next putFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-"));
    const src = join(dir, "a.wav");
    await writeFile(src, "x");
    const store = new FileAssetStore(join(dir, "cache"));
    await store.putFile("h", src, "wav", { kind: "audio", provider: "p" });
    await writeFile(join(dir, "cache", "h.json"), '{"kind": "audio", "prov');
    expect(await store.get("h")).toBeNull();
    await writeFile(join(dir, "cache", "h.json"), "{}");
    expect(await store.get("h")).toBeNull();
    const again = await store.putFile("h", src, "wav", { kind: "audio", provider: "p" });
    expect(again.fileName).toBe("h.wav");
    expect((await store.get("h"))?.meta.provider).toBe("p");
  });
});

describe("download helpers", () => {
  it("passes an AbortSignal to fetch", async () => {
    let signal: AbortSignal | null | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Response("ok");
    }) as typeof fetch;
    const dir = await mkdtemp(join(tmpdir(), "dl-"));
    await downloadTo("https://cdn.example/x.mp4", join(dir, "x.mp4"), fakeFetch);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("copies file:// URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-"));
    const src = join(dir, "in.txt");
    await writeFile(src, "hello");
    const dest = join(dir, "out.txt");
    await downloadTo(pathToFileURL(src).href, dest);
    await expect(readFile(dest, "utf8")).resolves.toBe("hello");
  });

  it("throws on HTTP errors without leaking query strings", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    await expect(downloadTo("https://cdn.example/x.mp4?token=secret", "/tmp/never", fakeFetch)).rejects.toThrow(
      /HTTP 403 .*cdn\.example\/x\.mp4$/,
    );
  });

  it("derives extensions and content types", () => {
    expect(extFromUrl("https://cdn/x/image.WEBP?sig=1", "png")).toBe("webp");
    expect(extFromUrl("https://cdn/x/noext", "png")).toBe("png");
    expect(contentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("a.wav")).toBe("audio/wav");
  });
});
