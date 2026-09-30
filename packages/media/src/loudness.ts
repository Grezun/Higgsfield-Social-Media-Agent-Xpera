import { runFfmpeg } from "./run";

export type LoudnessTarget = { i: number; tp: number; lra: number };
export const SOCIAL_LOUDNESS: LoudnessTarget = { i: -14, tp: -1, lra: 11 };
export const VOICE_LOUDNESS: LoudnessTarget = { i: -16, tp: -1.5, lra: 11 };

export type LoudnessMeasurement = {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
};

const num = (v: string | undefined) => (v === "-inf" ? -Infinity : v === "inf" ? Infinity : Number(v));

/** First pass of two-pass loudnorm: measures the input (printed as JSON on stderr). */
export async function measureLoudness(input: string, target: LoudnessTarget = SOCIAL_LOUDNESS): Promise<LoudnessMeasurement> {
  const { stderr } = await runFfmpeg([
    "-i", input, "-vn",
    "-af", `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}:print_format=json`,
    "-f", "null", "-",
  ]);
  const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  const raw = JSON.parse(json) as Record<string, string>;
  return {
    inputI: num(raw.input_i),
    inputTp: num(raw.input_tp),
    inputLra: num(raw.input_lra),
    inputThresh: num(raw.input_thresh),
    targetOffset: num(raw.target_offset),
  };
}

export const isSilent = (m: LoudnessMeasurement) => !Number.isFinite(m.inputI) || !Number.isFinite(m.inputThresh);

/** Second pass: a linear loudnorm filter using the first-pass measurement. */
export function loudnormFilter(m: LoudnessMeasurement, target: LoudnessTarget): string {
  return (
    `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}` +
    `:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}` +
    `:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true`
  );
}

export async function normalizeLoudness(input: string, output: string, target: LoudnessTarget = VOICE_LOUDNESS): Promise<void> {
  const m = await measureLoudness(input, target);
  const af = isSilent(m) ? "aresample=48000" : `${loudnormFilter(m, target)},aresample=48000`;
  await runFfmpeg(["-i", input, "-vn", "-af", af, "-ar", "48000", "-c:a", "pcm_s16le", output]);
}
