import type { Timeline, Word } from "@reel/core";
import { createTikTokStyleCaptions, type Caption, type TikTokPage } from "@remotion/captions";
import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { HEEBO } from "./fonts";

export const COMBINE_MS = 900;

/** @remotion/captions uses the leading space as the word delimiter, so every token starts with one. */
export function wordsToCaptions(words: Word[]): Caption[] {
  return words.map((w) => ({ text: ` ${w.text}`, startMs: w.startMs, endMs: w.endMs, timestampMs: w.startMs, confidence: null }));
}

function tokenStyle(preset: Timeline["style"]["captionPreset"], active: boolean, accent: string): React.CSSProperties {
  if (preset === "clean") {
    return {
      color: "#FFFFFF",
      textShadow: "0 4px 18px rgba(0,0,0,0.6)",
      background: active ? "rgba(0,0,0,0.55)" : "transparent",
      borderRadius: 12,
      padding: "0 0.12em",
    };
  }
  return {
    color: active ? accent : "#FFFFFF",
    WebkitTextStroke: "12px #000000",
    paintOrder: "stroke fill",
    transform: active ? "scale(1.12)" : "none",
  };
}

const CaptionPage: React.FC<{ page: TikTokPage; timeline: Timeline }> = ({ page, timeline }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = page.startMs + (frame / fps) * 1000;
  return (
    <div
      dir={timeline.direction}
      style={{
        position: "absolute",
        top: "60%",
        left: 70,
        right: 70,
        textAlign: "center",
        direction: timeline.direction,
        fontFamily: HEEBO,
        fontWeight: 800,
        fontSize: 78,
        lineHeight: 1.2,
      }}
    >
      {page.tokens.map((token, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            unicodeBidi: "isolate",
            margin: "0 0.12em",
            ...tokenStyle(timeline.style.captionPreset, nowMs >= token.fromMs && nowMs < token.toMs, timeline.style.palette[0]),
          }}
        >
          {token.text.trim()}
        </span>
      ))}
    </div>
  );
};

export const Captions: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps } = useVideoConfig();
  const pages = useMemo(
    () =>
      createTikTokStyleCaptions({
        captions: wordsToCaptions(timeline.captions.words),
        combineTokensWithinMilliseconds: COMBINE_MS,
      }).pages,
    [timeline.captions.words],
  );
  return (
    <AbsoluteFill>
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const endMs = pages[i + 1]?.startMs ?? page.startMs + page.durationMs;
        const durationInFrames = Math.max(1, Math.round((endMs / 1000) * fps) - from);
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames} layout="none">
            <CaptionPage page={page} timeline={timeline} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
