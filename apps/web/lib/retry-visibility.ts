export function canRetryGenerate(
  storyboard: { id: string; status: string },
  job: { type: string; status: string; payload: unknown } | null,
): boolean {
  if (storyboard.status !== "approved") return false;
  if (job && (job.status === "queued" || job.status === "running")) return false;
  if (job?.type === "generate" && job.status === "done") {
    const p = job.payload;
    const forThis = typeof p === "object" && p !== null && "storyboardId" in p && (p as { storyboardId: unknown }).storyboardId === storyboard.id;
    if (forThis) return false;
  }
  return true;
}
