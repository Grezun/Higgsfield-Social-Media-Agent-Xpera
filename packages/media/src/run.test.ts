import { afterEach, describe, expect, it } from "vitest";
import { assertFfmpegAvailable, FfmpegError, runFfmpeg } from "./run";

const originalPath = process.env.FFMPEG_PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = originalPath;
});

describe("runFfmpeg", () => {
  it("reports ffmpeg version", async () => {
    expect(await assertFfmpegAvailable()).toMatch(/^ffmpeg version/);
  });

  it("throws FfmpegError with the stderr tail on failure", async () => {
    const err = await runFfmpeg(["-i", "/definitely/missing.mp4", "-f", "null", "-"]).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.message).toMatch(/No such file or directory/);
    expect(err.args).toContain("/definitely/missing.mp4");
  });

  it("kills the process on timeout", async () => {
    const err = await runFfmpeg(["-re", "-f", "lavfi", "-i", "testsrc2=duration=120", "-f", "null", "-"], { timeoutMs: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.message).toMatch(/timed out after 300 ms/);
  });

  it("reports a missing binary clearly", async () => {
    process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
    await expect(runFfmpeg(["-version"])).rejects.toThrow(/failed to start/);
  });
});
