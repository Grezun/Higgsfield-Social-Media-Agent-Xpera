import { config as loadEnv } from "dotenv";
import {
  config,
  higgsfield,
  HiggsfieldError,
  APIError,
  TimeoutError,
} from "@higgsfield/client/v2";

// Load HF_CREDENTIALS from .env.local (server-side only; never logged).
loadEnv({ path: ".env.local", quiet: true });

if (!process.env.HF_CREDENTIALS) {
  console.error("HF_CREDENTIALS is not set. Add it to .env.local as key-id:key-secret.");
  process.exit(1);
}

config({
  credentials: process.env.HF_CREDENTIALS,
  // Video generation can take several minutes; the SDK default is 5 minutes.
  maxPollTime: 15 * 60 * 1000,
});

async function main() {
  const result = await higgsfield.subscribe("bytedance/seedance-2.5/text-to-video", {
    input: {
      prompt: "A cinematic scene at sunset",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
    },
    withPolling: true,
  });

  // The SDK types list queued/in_progress/completed/failed/nsfw, but the API
  // may also report canceled, so compare as a plain string.
  const status: string = result.status;

  if (status === "completed" && result.video?.url) {
    console.log(`Request ${result.request_id} completed.`);
    console.log(`Video URL: ${result.video.url}`);
    return;
  }

  if (status === "nsfw") {
    console.error(`Request ${result.request_id} was blocked by content moderation.`);
  } else if (status === "failed") {
    console.error(`Request ${result.request_id} failed.`);
  } else if (status === "canceled" || status === "cancelled") {
    console.error(`Request ${result.request_id} was canceled.`);
  } else if (status === "completed") {
    console.error(`Request ${result.request_id} completed but returned no video URL.`);
  } else {
    console.error(`Request ${result.request_id} ended with unexpected status "${status}".`);
  }
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof TimeoutError) {
    console.error(`Timed out waiting for the generation: ${err.message}`);
  } else if (err instanceof APIError) {
    console.error(`Higgsfield API error (${err.name}): ${err.message}`);
  } else if (err instanceof HiggsfieldError) {
    console.error(`Higgsfield SDK error (${err.name}): ${err.message}`);
  } else {
    console.error("Unexpected error:", err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
