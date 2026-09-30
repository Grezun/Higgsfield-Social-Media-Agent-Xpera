import { describe, expect, it } from "vitest";
import { parsePlanForm } from "./plan-form";

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  Object.entries(entries).forEach(([k, v]) => f.set(k, v));
  return f;
};
const base = { brief: "3 טיפים לצמיחה בטיקטוק", language: "he", targetDurationSec: "30", pacing: "punchy", captionPreset: "bold_pop", color1: "#ffe14d", color2: "#111111" };

describe("parsePlanForm", () => {
  it("parses a valid form into a PlanForm", () => {
    expect(parsePlanForm(fd(base))).toEqual({
      ok: true,
      form: { brief: base.brief, language: "he", targetDurationSec: 30, pacing: "punchy", captionPreset: "bold_pop", palette: ["#ffe14d", "#111111"] },
    });
  });
  it("includes a voice id only when given", () => {
    const r = parsePlanForm(fd({ ...base, voiceId: "  v-123 " }));
    expect(r.ok && r.form.voiceId).toBe("v-123");
  });
  it("returns readable errors", () => {
    const r = parsePlanForm(fd({ ...base, brief: "x", targetDurationSec: "20" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toMatch(/brief/);
    expect(!r.ok && r.errors.join("\n")).toMatch(/targetDurationSec/);
  });
});
