import { parseStoryboard } from "@reel/core";
import { access, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli";

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("reel CLI", () => {
  it("plan --fake writes a valid storyboard.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["plan", "--brief", "3 tips", "--out", dir, "--lang", "en", "--length", "15", "--fake"]);
    const sb = parseStoryboard(JSON.parse(await readFile(join(dir, "storyboard.json"), "utf8")));
    expect(sb.language).toBe("en");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("make rejects an invalid hand-edited storyboard before spending anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["plan", "--brief", "x", "--out", dir, "--fake"]);
    const file = join(dir, "storyboard.json");
    const sb = JSON.parse(await readFile(file, "utf8"));
    sb.scenes[0].visual.kind = "avatar";
    await writeFile(file, JSON.stringify(sb));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    await main(["make", dir, "--fake"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/scenes\.0\.visual\.kind: visual kind "avatar" is not allowed in a faceless reel/);
    await expect(access(join(dir, "renders"))).rejects.toThrow();
  });

  it("make reports malformed JSON clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    await writeFile(join(dir, "storyboard.json"), "{ not json");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    await main(["make", dir, "--fake"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/storyboard\.json is not valid JSON/);
  });

  it("plan rejects a bad --palette before planning or writing anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    await main(["plan", "--brief", "x", "--out", dir, "--palette", "red", "--fake"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/--palette/);
    await expect(access(join(dir, "storyboard.json"))).rejects.toThrow();
  });

  it("plan reports an unsupported --lang as a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    await main(["plan", "--brief", "x", "--out", dir, "--lang", "fr", "--fake"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/--lang[\s\S]*Usage:/);
  });

  it("plan rejects an unsupported --captions preset as a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    await main(["plan", "--brief", "x", "--out", dir, "--captions", "neon", "--fake"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/--captions[\s\S]*Usage:/);
  });

  it("make --fake keeps its cache under <cacheDir>/fake", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    const cache = await mkdtemp(join(tmpdir(), "cli-cache-"));
    const prev = process.env.REEL_CACHE_DIR;
    process.env.REEL_CACHE_DIR = cache;
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await main(["plan", "--brief", "x", "--out", dir, "--lang", "en", "--length", "15", "--fake"]);
      await main(["make", dir, "--fake"]);
      expect(process.exitCode ?? 0).toBe(0);
      expect((await readdir(join(cache, "fake"))).length).toBeGreaterThan(0);
      expect((await readdir(cache)).filter((f) => f !== "fake")).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.REEL_CACHE_DIR;
      else process.env.REEL_CACHE_DIR = prev;
    }
  }, 300_000);

  it("prints usage for unknown commands", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
    await main(["wat"]);
    expect(logs.join("\n")).toMatch(/Usage:/);
    expect(process.exitCode).toBe(1);
  });
});
