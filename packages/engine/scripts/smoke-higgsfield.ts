import { probe } from "@reel/media";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, loadEnvFile, REPO_ROOT } from "../src/config";
import { contentTypeFor, downloadTo, extFromUrl } from "../src/download";
import { HiggsfieldGateway, HiggsfieldImageGen, HiggsfieldUploader, HiggsfieldVideoGen, sdkSubscribe } from "../src/providers/higgsfield";

// Checks image → upload → image-to-video end to end (spends a few credits).
loadEnvFile();
const config = loadConfig();
const credentials = config.higgsfield.credentials;
if (!credentials) {
  console.error("HF_CREDENTIALS is not set in .env.local (format key-id:key-secret)");
  process.exit(1);
}
const outDir = join(REPO_ROOT, "work", "smoke");
await mkdir(outDir, { recursive: true });
const gateway = new HiggsfieldGateway(sdkSubscribe(credentials), 1);

const image = await new HiggsfieldImageGen(gateway, config.higgsfield.imageModel).generate({
  prompt: "A barista pouring latte art, warm morning light, close-up, vertical 9:16 framing",
});
const imageFile = join(outDir, `image.${extFromUrl(image.url, "png")}`);
await downloadTo(image.url, imageFile);
const imageInfo = await probe(imageFile);
console.log(`image ${image.requestId}: ${imageInfo.video?.width}×${imageInfo.video?.height} → ${imageFile}`);

const publicUrl = await new HiggsfieldUploader(credentials, config.higgsfield.baseUrl).upload(await readFile(imageFile), contentTypeFor(imageFile));
console.log(`uploaded → ${publicUrl}`);

const video = await new HiggsfieldVideoGen(gateway, config.higgsfield.videoModel, config.higgsfield.videoResolution).imageToVideo({
  imageUrl: publicUrl,
  prompt: "slow push-in, steam rising from the cup",
  durationSec: 4,
});
const videoFile = join(outDir, "video.mp4");
await downloadTo(video.url, videoFile);
const v = await probe(videoFile);
console.log(`video ${video.requestId}: ${v.video?.width}×${v.video?.height} @ ${v.video?.fps.toFixed(2)} fps, ${v.durationSec.toFixed(2)} s, audio: ${v.audio ? "PRESENT (unexpected)" : "none"} → ${videoFile}`);
