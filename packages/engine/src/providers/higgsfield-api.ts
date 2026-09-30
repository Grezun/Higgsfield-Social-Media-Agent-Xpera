import { FETCH_TIMEOUT_MS } from "../download";

export type HfStatus = { status: string; request_id: string; images?: { url: string }[]; video?: { url: string } };

export class HfHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HfHttpError";
  }
}

export interface HiggsfieldApi {
  /** Starts a generation; resolves to its request id. */
  submit(model: string, input: Record<string, unknown>): Promise<string>;
  status(requestId: string): Promise<HfStatus>;
}

const errCode = (err: unknown) => (err as { code?: string; cause?: { code?: string } } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code ?? "";

/** Codes that can only occur before a connection exists, so the request never reached the server. */
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
/** Codes that can occur after the request was (partly) sent, so a job may already exist. */
const MID_FLIGHT_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

/** Connection-level failures (either kind); polling tolerates all of them. */
export const isNetworkError = (err: unknown) => PRE_CONNECT_CODES.has(errCode(err)) || MID_FLIGHT_CODES.has(errCode(err));

/** A 2xx submit whose response we could not use: a job likely exists, so it must not be retried. */
export class AmbiguousSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousSubmitError";
  }
}

/** A submit that timed out, dropped mid-flight, or got an unusable 2xx may still have created (and billed) a job, so it must not be retried. */
export const isAmbiguousSubmitError = (err: unknown) =>
  err instanceof AmbiguousSubmitError ||
  MID_FLIGHT_CODES.has(errCode(err)) ||
  (err instanceof HfHttpError && err.status === 504) ||
  (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));

/** A submit that failed before a job existed is safe to retry. */
export function isRetryableSubmitError(err: unknown): boolean {
  if (err instanceof HfHttpError) return err.status === 429 || (err.status >= 500 && err.status !== 504) || (err.status === 400 && /concurrent/i.test(err.message));
  return PRE_CONNECT_CODES.has(errCode(err));
}

export function httpHiggsfieldApi(credentials: string, baseUrl = "https://api.higgsfield.ai", fetchImpl: typeof fetch = fetch): HiggsfieldApi {
  const root = baseUrl.replace(/\/+$/, "");
  const headers = { "User-Agent": "reel-agent/1.0", Authorization: `Key ${credentials}`, "Content-Type": "application/json", Accept: "application/json" };
  const call = async (url: string, init: RequestInit) => {
    const res = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new HfHttpError(res.status, `Higgsfield HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as HfStatus;
  };
  return {
    async submit(model, input) {
      const body = await call(`${root}/${model}`, { method: "POST", body: JSON.stringify(input) });
      if (!body.request_id) throw new AmbiguousSubmitError("Higgsfield submit succeeded but returned no request_id; the job may have been created — check the Higgsfield dashboard before retrying");
      return body.request_id;
    },
    status: (requestId) => call(`${root}/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" }),
  };
}
