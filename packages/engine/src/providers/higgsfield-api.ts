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

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);
export const isNetworkError = (err: unknown) =>
  NETWORK_CODES.has((err as { code?: string; cause?: { code?: string } } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code ?? "") ||
  (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));

/** A submit that failed before a job existed is safe to retry. */
export function isRetryableSubmitError(err: unknown): boolean {
  if (err instanceof HfHttpError) return err.status === 429 || err.status >= 500 || (err.status === 400 && /concurrent/i.test(err.message));
  return isNetworkError(err);
}

export function httpHiggsfieldApi(credentials: string, baseUrl = "https://api.higgsfield.ai", fetchImpl: typeof fetch = fetch): HiggsfieldApi {
  const headers = { Authorization: `Key ${credentials}`, "Content-Type": "application/json", Accept: "application/json" };
  const call = async (url: string, init: RequestInit) => {
    const res = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new HfHttpError(res.status, `Higgsfield HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as HfStatus;
  };
  return {
    async submit(model, input) {
      const body = await call(`${baseUrl}/${model}`, { method: "POST", body: JSON.stringify(input) });
      if (!body.request_id) throw new HfHttpError(502, "Higgsfield submit returned no request_id");
      return body.request_id;
    },
    status: (requestId) => call(`${baseUrl}/requests/${encodeURIComponent(requestId)}/status`, { method: "GET" }),
  };
}
