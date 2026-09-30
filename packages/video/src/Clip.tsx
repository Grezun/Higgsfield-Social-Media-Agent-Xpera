import type { TimelineClip } from "@reel/core";
import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame } from "remotion";
import { enterStyle, motionTransform } from "./motion";

const FILL: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

export const Clip: React.FC<{ clip: TimelineClip; palette: string[] }> = ({ clip, palette }) => {
  const frame = useCurrentFrame();
  let media: React.ReactNode;
  if (clip.kind === "video" && clip.src) {
    media = <OffthreadVideo src={clip.src} muted style={FILL} />;
  } else if (clip.kind === "image" && clip.src) {
    media = <Img src={clip.src} style={FILL} />;
  } else {
    media = <AbsoluteFill style={{ background: `linear-gradient(160deg, ${palette[0]} 0%, ${palette[1] ?? "#111111"} 100%)` }} />;
  }
  return (
    <AbsoluteFill style={enterStyle(clip.transitionIn, frame)}>
      <AbsoluteFill style={{ transform: motionTransform(clip.motion, frame, clip.durationInFrames) }}>{media}</AbsoluteFill>
    </AbsoluteFill>
  );
};
