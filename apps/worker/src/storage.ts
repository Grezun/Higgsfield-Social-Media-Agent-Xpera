import { BUCKETS, type Database, type Json } from "@reel/db";
import { contentTypeFor, type AssetMeta, type AssetStore, type FileAssetStore, type StoredAsset } from "@reel/engine";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export interface BlobStore {
  upload(bucket: string, path: string, filePath: string, contentType: string): Promise<void>;
  download(bucket: string, path: string, destPath: string): Promise<void>;
}

export type AssetRecord = {
  inputHash: string;
  kind: AssetMeta["kind"];
  fileName: string;
  storagePath: string;
  provider: string;
  model?: string;
  requestId?: string;
  meta: { estUsd?: number; createdAt: string; extra?: Record<string, unknown> };
};

export interface AssetIndex {
  find(hash: string): Promise<AssetRecord | null>;
  insert(record: AssetRecord): Promise<void>;
}

export class SupabaseBlobStore implements BlobStore {
  constructor(private readonly sb: SupabaseClient<Database>) {}

  async upload(bucket: string, path: string, filePath: string, contentType: string): Promise<void> {
    const { error } = await this.sb.storage.from(bucket).upload(path, await readFile(filePath), { contentType, upsert: true });
    if (error) throw new Error(`upload ${bucket}/${path} failed: ${error.message}`);
  }

  async download(bucket: string, path: string, destPath: string): Promise<void> {
    const { data, error } = await this.sb.storage.from(bucket).download(path);
    if (error || !data) throw new Error(`download ${bucket}/${path} failed: ${error?.message ?? "no data"}`);
    await writeFile(destPath, Buffer.from(await data.arrayBuffer()));
  }
}

export class SupabaseAssetIndex implements AssetIndex {
  constructor(private readonly sb: SupabaseClient<Database>) {}

  async find(hash: string): Promise<AssetRecord | null> {
    const { data, error } = await this.sb.from("assets").select("*").eq("input_hash", hash).maybeSingle();
    if (error) throw new Error(`asset lookup failed: ${error.message}`);
    if (!data) return null;
    return {
      inputHash: data.input_hash,
      kind: data.kind as AssetRecord["kind"],
      fileName: data.file_name,
      storagePath: data.storage_path,
      provider: data.provider,
      model: data.model ?? undefined,
      requestId: data.provider_request_id ?? undefined,
      meta: (data.meta ?? {}) as AssetRecord["meta"],
    };
  }

  async insert(r: AssetRecord): Promise<void> {
    const { error } = await this.sb.from("assets").upsert(
      {
        input_hash: r.inputHash,
        kind: r.kind,
        file_name: r.fileName,
        storage_path: r.storagePath,
        provider: r.provider,
        model: r.model ?? null,
        provider_request_id: r.requestId ?? null,
        meta: r.meta as Json,
      },
      { onConflict: "input_hash", ignoreDuplicates: true },
    );
    if (error) throw new Error(`asset index insert failed: ${error.message}`);
  }
}

/**
 * Local disk cache (Remotion/FFmpeg need local files) mirrored to Supabase Storage + the `assets` table,
 * so any worker machine can restore an asset instead of paying for it again.
 */
export class MirroredAssetStore implements AssetStore {
  constructor(
    private readonly local: FileAssetStore,
    private readonly blobs: BlobStore,
    private readonly index: AssetIndex,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get root(): string {
    return this.local.root;
  }

  async get(hash: string): Promise<StoredAsset | null> {
    const hit = await this.local.get(hash);
    if (hit) return hit;
    const record = await this.index.find(hash);
    if (!record) return null;
    await mkdir(this.local.root, { recursive: true });
    const tmp = join(this.local.root, `${record.fileName}.download-${randomUUID()}`);
    try {
      await this.blobs.download(BUCKETS.assets, record.storagePath, tmp);
      return await this.local.putFile(hash, tmp, extname(record.fileName).slice(1), {
        kind: record.kind,
        provider: record.provider,
        model: record.model,
        requestId: record.requestId,
        estUsd: record.meta.estUsd,
        extra: record.meta.extra,
      });
    } catch (err) {
      this.log(`cache restore failed for ${hash}: ${err instanceof Error ? err.message : err}; it will be regenerated`);
      return null;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async putFile(hash: string, sourcePath: string, ext: string, meta: Omit<AssetMeta, "createdAt">): Promise<StoredAsset> {
    const stored = await this.local.putFile(hash, sourcePath, ext, meta);
    // Upload before indexing so the index never points at a missing object.
    await this.blobs.upload(BUCKETS.assets, stored.fileName, stored.path, contentTypeFor(stored.fileName));
    await this.index.insert({
      inputHash: hash,
      kind: meta.kind,
      fileName: stored.fileName,
      storagePath: stored.fileName,
      provider: meta.provider,
      model: meta.model,
      requestId: meta.requestId,
      meta: { estUsd: meta.estUsd, createdAt: stored.meta.createdAt, extra: meta.extra },
    });
    return stored;
  }
}
