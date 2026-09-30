import { loadFont } from "@remotion/google-fonts/Heebo";

// Heebo covers Hebrew and Latin. Timeline.style.font is reserved for more fonts later; all text uses Heebo for now.
export const { fontFamily: HEEBO } = loadFont("normal", { weights: ["800"], subsets: ["hebrew", "latin"] });
