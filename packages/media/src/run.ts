import { spawn } from "node:child_process";

export class FfmpegError extends Error {
  constructor(message: string, readonly args: string[], readonly stderrTail: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_CHARS = 64 * 1024;
const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobeBin = () => process.env.FFPROBE_PATH || "ffprobe";

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`${bin} failed to start: ${err.message}`, args, ""));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = stderr.trimEnd().split("\n").slice(-20).join("\n");
      if (timedOut) reject(new FfmpegError(`${bin} timed out after ${timeoutMs} ms`, args, tail));
      else if (code !== 0) reject(new FfmpegError(`${bin} exited with code ${code}:\n${tail}`, args, tail));
      else resolve({ stdout, stderr });
    });
  });
}

export function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}) {
  return run(ffmpegBin(), ["-hide_banner", "-nostdin", "-y", ...args], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export function runFfprobe(args: string[], opts: { timeoutMs?: number } = {}) {
  return run(ffprobeBin(), ["-v", "error", ...args], opts.timeoutMs ?? 60_000);
}

export async function assertFfmpegAvailable(): Promise<string> {
  const { stdout } = await run(ffmpegBin(), ["-version"], 10_000);
  return stdout.split("\n")[0];
}
