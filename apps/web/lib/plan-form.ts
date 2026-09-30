import { PlanFormSchema, type PlanForm } from "@reel/core";

export type ParsedPlanForm = { ok: true; form: PlanForm } | { ok: false; errors: string[] };

export function parsePlanForm(fd: FormData): ParsedPlanForm {
  const str = (key: string) => {
    const v = fd.get(key);
    return typeof v === "string" ? v : "";
  };
  const voiceId = str("voiceId").trim();
  const raw = {
    brief: str("brief"),
    language: str("language"),
    targetDurationSec: Number(str("targetDurationSec")),
    pacing: str("pacing"),
    captionPreset: str("captionPreset"),
    palette: [str("color1"), str("color2")].filter(Boolean),
    ...(voiceId ? { voiceId } : {}),
  };
  const result = PlanFormSchema.safeParse(raw);
  if (result.success) return { ok: true, form: result.data };
  return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`) };
}
