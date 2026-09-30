"use client";
import { useActionState } from "react";
import { createReel, type NewReelState } from "./actions";

export function NewReelForm() {
  const [state, action, pending] = useActionState<NewReelState, FormData>(createReel, {});
  return (
    <form action={action} className="stack card">
      <label>
        Brief: what is this reel about, for whom, and what should viewers do?
        <textarea name="brief" dir="auto" required minLength={3} maxLength={2000} rows={5} />
      </label>
      <div className="row">
        <label>Language<select name="language" defaultValue="he"><option value="he">עברית</option><option value="en">English</option></select></label>
        <label>Length<select name="targetDurationSec" defaultValue="30">{[15, 30, 45, 60].map((s) => <option key={s} value={s}>{s}s</option>)}</select></label>
        <label>Pacing<select name="pacing" defaultValue="punchy"><option value="punchy">Punchy</option><option value="calm">Calm</option></select></label>
        <label>Captions<select name="captionPreset" defaultValue="bold_pop"><option value="bold_pop">Bold pop</option><option value="clean">Clean</option></select></label>
        <label>Accent<input name="color1" type="color" defaultValue="#ffe14d" /></label>
        <label>Background<input name="color2" type="color" defaultValue="#111111" /></label>
      </div>
      <label>
        ElevenLabs voice ID (optional; defaults to the team voice for the language)
        <input name="voiceId" dir="ltr" autoComplete="off" />
      </label>
      {state.errors && <ul role="alert" className="error">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="row">
        <button type="submit" className="primary" disabled={pending}>{pending ? "Creating…" : "Create storyboard"}</button>
        <span className="muted">Planning uses Claude only; nothing is generated until you approve.</span>
      </div>
    </form>
  );
}
