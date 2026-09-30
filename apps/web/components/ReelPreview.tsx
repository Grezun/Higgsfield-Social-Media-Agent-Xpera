"use client";
import type { Timeline } from "@reel/core";
import { Reel } from "@reel/video/reel";
import { Player } from "@remotion/player";
import { useMemo } from "react";

export function ReelPreview({ timeline, reelUrl }: { timeline: Timeline; reelUrl: string }) {
  const inputProps = useMemo(() => ({ timeline }), [timeline]);
  return (
    <section className="card stack" style={{ alignItems: "center" }}>
      <Player
        component={Reel}
        inputProps={inputProps}
        durationInFrames={timeline.durationInFrames}
        fps={timeline.fps}
        compositionWidth={timeline.width}
        compositionHeight={timeline.height}
        controls
        acknowledgeRemotionLicense
        style={{ width: "100%", maxWidth: 360, aspectRatio: "9 / 16", borderRadius: 8 }}
      />
      <a className="button primary" href={reelUrl}>Download MP4 (1080×1920)</a>
    </section>
  );
}
