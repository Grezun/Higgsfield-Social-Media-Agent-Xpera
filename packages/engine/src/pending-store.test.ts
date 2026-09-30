import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilePendingStore, MemoryPendingStore, type PendingStore } from "./pending-store";

const KEY = "a".repeat(64);
const rec = { requestId: "req-1", model: "m", submittedAt: "2026-10-01T00:00:00.000Z" };

const contract = (make: () => Promise<PendingStore>) => {
  it("round-trips set/get", async () => {
    const s = await make();
    await s.set(KEY, rec);
    expect(await s.get(KEY)).toEqual(rec);
  });
  it("delete removes the record", async () => {
    const s = await make();
    await s.set(KEY, rec);
    await s.delete(KEY);
    expect(await s.get(KEY)).toBeNull();
  });
  it("returns null for an unknown key", async () => {
    expect(await (await make()).get("b".repeat(64))).toBeNull();
  });
};

describe("MemoryPendingStore", () => contract(async () => new MemoryPendingStore()));

describe("FilePendingStore", () => {
  const dirFor = () => mkdtemp(path.join(tmpdir(), "pending-"));
  contract(async () => new FilePendingStore(await dirFor()));

  it("rejects keys that are not 64-hex hashes", async () => {
    const s = new FilePendingStore(await dirFor());
    await expect(s.get("../evil")).rejects.toThrow(Error);
    await expect(s.set("a/b", rec)).rejects.toThrow(/invalid pending key/);
    await expect(s.delete("..")).rejects.toThrow(Error);
  });

  it("treats a corrupt file as null and removes it", async () => {
    const dir = await dirFor();
    await writeFile(path.join(dir, `${KEY}.json`), "{not json");
    const s = new FilePendingStore(dir);
    expect(await s.get(KEY)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});
