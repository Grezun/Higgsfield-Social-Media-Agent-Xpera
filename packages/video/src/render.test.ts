import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReelStill } from "./render";
import { sampleTimeline } from "./sample-timeline";

// Written to work/stills so a human can open them (see Step 8).
const OUT = resolve("work/stills");

describe("renderReelStill", () => {
  it.each(["he", "en"] as const)("renders a %s frame with captions and an overlay", async (lang) => {
    await mkdir(OUT, { recursive: true });
    const file = join(OUT, `sample-${lang}.png`);
    await renderReelStill(sampleTimeline(lang), file, 20);
    expect((await stat(file)).size).toBeGreaterThan(20_000);
  }, 300_000);
});
