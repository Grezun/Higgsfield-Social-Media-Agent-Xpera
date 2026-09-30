import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { contentTypeFor } from "./download";

/** Serves a flat directory over http://127.0.0.1 so Remotion's headless browser can load cached assets. */
export async function serveDir(root: string) {
  const server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname).replace(/^\/+/, "");
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        res.writeHead(404).end();
        return;
      }
      const file = path.join(root, name);
      const { size } = await stat(file);
      const headers = { "Content-Type": contentTypeFor(name), "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...headers, "Content-Length": size });
        createReadStream(file).pipe(res);
      }
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    urlFor: (fileName: string) => `${origin}/${encodeURIComponent(fileName)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
