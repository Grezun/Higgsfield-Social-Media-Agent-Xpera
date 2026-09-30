import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type AssetKind = "image" | "video" | "audio";
export type AssetMeta = {
  kind: AssetKind;
  provider: string;
  model?: string;
  requestId?: string;
  estUsd?: number;
  createdAt: string;
  extra?: Record<string, unknown>;
};
export type StoredAsset = { hash: string; fileName: string; path: string; meta: AssetMeta };

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Where the pipeline caches provider outputs. `root` is a local directory holding every returned `path`. */
export interface AssetStore {
  readonly root: string;
  get(hash: string): Promise<StoredAsset | null>;
  putFile(hash: string, sourcePath: string, ext: string, meta: Omit<AssetMeta, "createdAt">): Promise<StoredAsset>;
}

/** Content-addressed cache: <root>/<hash>.<ext> plus <root>/<hash>.json metadata. */
export class FileAssetStore implements AssetStore {
  constructor(readonly root: string) {}

  async get(hash: string): Promise<StoredAsset | null> {
    try {
      const jsonPath = path.join(this.root, `${hash}.json`);
      let parsed: (AssetMeta & { fileName?: unknown }) | null;
      try {
        parsed = JSON.parse(await readFile(jsonPath, "utf8")) as AssetMeta & { fileName?: unknown };
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        parsed = null;
      }
      if (!parsed || typeof parsed.fileName !== "string" || !parsed.fileName || parsed.fileName !== path.basename(parsed.fileName)) {
        await unlink(jsonPath).catch(() => {}); // corrupt metadata is a miss; best-effort cleanup
        return null;
      }
      const { fileName, ...meta } = parsed as AssetMeta & { fileName: string };
      const filePath = path.join(this.root, fileName);
      await access(filePath);
      return { hash, fileName, path: filePath, meta };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putFile(hash: string, sourcePath: string, ext: string, meta: Omit<AssetMeta, "createdAt">): Promise<StoredAsset> {
    await mkdir(this.root, { recursive: true });
    const fileName = `${hash}.${ext}`;
    const filePath = path.join(this.root, fileName);
    const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await copyFile(sourcePath, tmp);
    await rename(tmp, filePath);
    const full: AssetMeta = { ...meta, createdAt: new Date().toISOString() };
    const jsonPath = path.join(this.root, `${hash}.json`);
    const jsonTmp = `${jsonPath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(jsonTmp, JSON.stringify({ ...full, fileName }, null, 2));
    await rename(jsonTmp, jsonPath);
    return { hash, fileName, path: filePath, meta: full };
  }
}
