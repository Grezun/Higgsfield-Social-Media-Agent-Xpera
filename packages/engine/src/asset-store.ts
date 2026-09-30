import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Content-addressed cache: <root>/<hash>.<ext> plus <root>/<hash>.json metadata. */
export class FileAssetStore {
  constructor(readonly root: string) {}

  async get(hash: string): Promise<StoredAsset | null> {
    try {
      const { fileName, ...meta } = JSON.parse(await readFile(path.join(this.root, `${hash}.json`), "utf8")) as AssetMeta & { fileName: string };
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
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(sourcePath, tmp);
    await rename(tmp, filePath);
    const full: AssetMeta = { ...meta, createdAt: new Date().toISOString() };
    await writeFile(path.join(this.root, `${hash}.json`), JSON.stringify({ ...full, fileName }, null, 2));
    return { hash, fileName, path: filePath, meta: full };
  }
}
