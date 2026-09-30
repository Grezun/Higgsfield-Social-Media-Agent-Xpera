import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveDir } from "./serve";

let server: Awaited<ReturnType<typeof serveDir>>;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "serve-"));
  await writeFile(join(dir, "clip.mp4"), "0123456789");
  server = await serveDir(dir);
});
afterAll(() => server.close());

describe("serveDir", () => {
  it("serves a file with its content type", async () => {
    const res = await fetch(server.urlFor("clip.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("0123456789");
  });

  it("supports byte ranges", async () => {
    const res = await fetch(server.urlFor("clip.mp4"), { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("2345");
  });

  it("refuses path traversal and missing files", async () => {
    expect((await fetch(`${server.origin}/..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(server.urlFor("missing.mp4"))).status).toBe(404);
  });
});
