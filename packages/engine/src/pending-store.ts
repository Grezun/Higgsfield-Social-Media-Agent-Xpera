import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type PendingRecord = { requestId: string; model: string; submittedAt: string };

/** Remembers provider request ids that were submitted but not yet collected, so a retry can resume instead of paying again. */
export interface PendingStore {
  get(key: string): Promise<PendingRecord | null>;
  set(key: string, record: PendingRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

const assertKey = (key: string) => {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`invalid pending key "${key}"`);
};

export class FilePendingStore implements PendingStore {
  constructor(private readonly dir: string) {}
  private file(key: string) {
    assertKey(key);
    return path.join(this.dir, `${key}.json`);
  }
  async get(key: string) {
    const file = this.file(key);
    try {
      const rec = JSON.parse(await readFile(file, "utf8")) as Partial<PendingRecord>;
      if (typeof rec.requestId === "string" && typeof rec.model === "string" && typeof rec.submittedAt === "string") return rec as PendingRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      if (!(err instanceof SyntaxError)) throw err;
    }
    await rm(file, { force: true });
    return null;
  }
  async set(key: string, record: PendingRecord) {
    const file = this.file(key);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, file);
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

export class MemoryPendingStore implements PendingStore {
  readonly records = new Map<string, PendingRecord>();
  async get(key: string) { return this.records.get(key) ?? null; }
  async set(key: string, record: PendingRecord) { this.records.set(key, record); }
  async delete(key: string) { this.records.delete(key); }
}
