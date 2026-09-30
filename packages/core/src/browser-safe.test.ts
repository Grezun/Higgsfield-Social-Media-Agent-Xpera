import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @reel/core's main entry is imported by the web app's browser bundle: nothing it reaches may import node: modules.
describe("@reel/core main entry", () => {
  it("does not re-export modules that import node: builtins", () => {
    const dir = join(import.meta.dirname, ".");
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    const reexported = [...index.matchAll(/from "\.\/(.+?)"/g)].map((m) => m[1]);
    const offenders = reexported.filter((mod) => {
      const file = [join(dir, `${mod}.ts`), join(dir, mod, "index.ts")].find((f) => { try { readFileSync(f); return true; } catch { return false; } });
      return file ? /from "node:/.test(readFileSync(file, "utf8")) : false;
    });
    expect(offenders).toEqual([]);
    expect(readdirSync(dir)).toContain("hash.ts");
  });
});
