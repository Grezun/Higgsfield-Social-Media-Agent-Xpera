import { describe, expect, it } from "vitest";
import { canRetryGenerate } from "./retry-visibility";

const sb = { id: "sb1", status: "approved" };
describe("canRetryGenerate", () => {
  it("approved with no job", () => expect(canRetryGenerate(sb, null)).toBe(true));
  it("approved with an active job", () => {
    expect(canRetryGenerate(sb, { type: "generate", status: "running", payload: { storyboardId: "sb1" } })).toBe(false);
    expect(canRetryGenerate(sb, { type: "generate", status: "queued", payload: {} })).toBe(false);
  });
  it("approved with a done generate for this storyboard", () =>
    expect(canRetryGenerate(sb, { type: "generate", status: "done", payload: { storyboardId: "sb1" } })).toBe(false));
  it("approved with a done generate for another storyboard", () =>
    expect(canRetryGenerate(sb, { type: "generate", status: "done", payload: { storyboardId: "old" } })).toBe(true));
  it("tolerates a malformed payload", () =>
    expect(canRetryGenerate(sb, { type: "generate", status: "done", payload: null })).toBe(true));
  it("draft", () => expect(canRetryGenerate({ id: "sb1", status: "draft" }, null)).toBe(false));
});
