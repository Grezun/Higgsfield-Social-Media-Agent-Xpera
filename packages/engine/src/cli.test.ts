import { parseStoryboard } from "@reel/core";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("prints usage for unknown commands", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
    await main(["wat"]);
    expect(logs.join("\n")).toMatch(/Usage:/);
    expect(process.exitCode).toBe(1);
  });
});
