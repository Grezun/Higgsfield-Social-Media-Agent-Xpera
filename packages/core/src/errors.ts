export class PermanentProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly requestId?: string) {
    super(message);
    this.name = "PermanentProviderError";
  }
}

export class SpendCapError extends Error {
  constructor(readonly estimateUsd: number, readonly capUsd: number) {
    super(`Estimated cost $${estimateUsd.toFixed(2)} exceeds the per-reel cap of $${capUsd.toFixed(2)}`);
    this.name = "SpendCapError";
  }
}

export class SceneFailuresError extends Error {
  constructor(readonly failures: { sceneId: string; reason: string }[]) {
    super(`${failures.length} scene(s) failed:\n${failures.map((f) => `  - ${f.sceneId}: ${f.reason}`).join("\n")}`);
    this.name = "SceneFailuresError";
  }
}

export class UnsupportedFormatError extends Error {
  constructor(readonly format: string) {
    super(`Format "${format}" is not supported yet (Phase 1 supports "faceless")`);
    this.name = "UnsupportedFormatError";
  }
}

export class UnknownCostModelError extends Error {
  constructor(readonly model: string) {
    super(`No cost entry for model "${model}". Add it to the cost table before generating.`);
    this.name = "UnknownCostModelError";
  }
}
