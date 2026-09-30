import React from "react";
import { Composition } from "remotion";
import { Reel, type ReelProps } from "./Reel";
import { sampleTimeline } from "./sample-timeline";

const defaults: ReelProps = { timeline: sampleTimeline("he") };

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Reel"
    component={Reel}
    durationInFrames={defaults.timeline.durationInFrames}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.timeline.durationInFrames,
      fps: props.timeline.fps,
      width: props.timeline.width,
      height: props.timeline.height,
    })}
  />
);
