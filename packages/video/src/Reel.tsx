import type { Timeline } from "@reel/core";
import React from "react";
import { AbsoluteFill, Audio, Sequence } from "remotion";
import { Captions } from "./Captions";
import { Clip } from "./Clip";
import { TRANSITION_FRAMES } from "./motion";
import { Overlays } from "./Overlays";

export type ReelProps = { timeline: Timeline };

export const Reel: React.FC<ReelProps> = ({ timeline }) => {
  const { clips, audio } = timeline;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {clips.map((clip, i) => {
        // Keep the outgoing clip visible while the next one animates in on top, so cuts stay on the audio beat.
        const next = clips[i + 1];
        const overlap = next && next.transitionIn !== "cut" ? TRANSITION_FRAMES : 0;
        return (
          <Sequence key={clip.sceneId} from={clip.fromFrame} durationInFrames={clip.durationInFrames + overlap}>
            <Clip clip={clip} palette={timeline.style.palette} />
          </Sequence>
        );
      })}
      <Overlays timeline={timeline} />
      <Captions timeline={timeline} />
      {audio.voiceUrl ? <Audio src={audio.voiceUrl} /> : null}
      {audio.musicUrl ? <Audio src={audio.musicUrl} loop volume={Math.pow(10, audio.musicDuckingDb / 20)} /> : null}
    </AbsoluteFill>
  );
};
