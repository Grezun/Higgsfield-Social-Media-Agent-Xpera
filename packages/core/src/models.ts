/** Model ids used for generation and cost estimates; shared by the worker (engine config) and the web app (estimates). */
export const DEFAULT_MODELS = {
  image: "higgsfield-ai/soul/v2/standard",
  video: "bytedance/seedance-2.5/image-to-video",
  voiceModelId: "eleven_v4",
} as const;

export function costModelsFor(voiceModelId: string) {
  return { image: DEFAULT_MODELS.image, video: DEFAULT_MODELS.video, voice: `elevenlabs/${voiceModelId}` };
}
