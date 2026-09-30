import type { Timeline, TimelineOverlay } from "@reel/core";
import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { HEEBO } from "./fonts";
import { popScale, typedLength } from "./motion";

const TOP: Record<TimelineOverlay["position"], string> = { top: "9%", center: "40%", bottom: "80%" };

const OverlayText: React.FC<{ overlay: TimelineOverlay; timeline: Timeline }> = ({ overlay, timeline }) => {
  const frame = useCurrentFrame();
  const text = overlay.animation === "type" ? [...overlay.text].slice(0, typedLength(overlay.text, frame)).join("") : overlay.text;
  const opacity = overlay.animation === "fade" ? Math.min(1, frame / 8) : 1;
  const scale = overlay.animation === "pop" ? popScale(frame) : 1;
  return (
    <div dir={timeline.direction} style={{ position: "absolute", top: TOP[overlay.position], left: 0, right: 0, display: "flex", justifyContent: "center", opacity }}>
      <span
        style={{
          fontFamily: HEEBO,
          fontWeight: 800,
          fontSize: 64,
          color: "#FFFFFF",
          background: timeline.style.palette[1] ?? "#111111",
          padding: "12px 28px",
          borderRadius: 18,
          transform: `scale(${scale})`,
          direction: timeline.direction,
          unicodeBidi: "isolate",
        }}
      >
        {text}
      </span>
    </div>
  );
};

export const Overlays: React.FC<{ timeline: Timeline }> = ({ timeline }) => (
  <AbsoluteFill>
    {timeline.overlays.map((overlay, i) => (
      <Sequence key={i} from={overlay.fromFrame} durationInFrames={overlay.durationInFrames} layout="none">
        <OverlayText overlay={overlay} timeline={timeline} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
