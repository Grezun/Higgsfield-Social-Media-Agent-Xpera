Create a polished {{LANGUAGE}} social video in a presenter-led style, combining a personal opening, a modern studio setting, supporting demonstrations, animated labels, and accurate captions.
VARIABLES
Topic: {{TOPIC}}
Audience: {{TARGET_AUDIENCE}}
Main message: {{MAIN_MESSAGE}}
Exact {{LANGUAGE}} narration: {{{{LANGUAGE}}_SCRIPT}}
Call to action: {{CTA}}
Presenter reference: {{PRESENTER_REFERENCE}}
Product images, screenshots, or footage: {{SUPPORTING_ASSETS}}
Brand accent color: {{ACCENT_COLOR}}
Target duration: {{DURATION_SECONDS}} seconds
Voice reference or selected voice: {{VOICE}}
OUTPUT
Deliver a vertical 9:16 video at 1080 × 1920, a separate {{LANGUAGE}} SRT subtitle file, and an editable composition when supported.
STYLE
Use natural, confident delivery and a clean, contemporary look. The presenter should feel approachable and credible. Combine direct eye contact, subtle hand gestures, close-ups, medium shots, and relevant supporting visuals.
Keep the same presenter identity, clothing, and voice throughout. Preserve facial details from the supplied reference.
STORY STRUCTURE
Adapt the timing to the narration:
First 15%: Personal close-up in a believable everyday setting. Open with the audience’s problem, a compelling question, or a clear benefit.
Next 20%: Transition into a modern studio. Introduce the main idea.
Middle 40%: Demonstrate the idea with supporting footage, actual screenshots, product views, or clearly designed graphics. Alternate these with presenter shots.
Next 15%: Show the result or strongest benefit.
Final 10%: Return to a presenter close-up and deliver the call to action.
{{LANGUAGE}} SPEECH
Generate narration separately using a model with verified {{LANGUAGE}} support. Use natural Israeli {{LANGUAGE}}, conversational pacing, and the selected voice consistently.
Speak {{{{LANGUAGE}}_SCRIPT}} exactly. Do not translate, paraphrase, invent words, or speak production instructions. Check names, numbers, acronyms, and foreign words before generating.
Measure the narration before creating footage. If it exceeds the target duration, flag the mismatch for script revision instead of rushing, truncating, or changing the words.
VISUAL GENERATION
Use Higgsfield for clean presenter footage and supporting scenes. Generate scenes without embedded captions, graphic labels, or generated dialogue.
For speaking presenter shots, lip-sync to the approved narration. Preserve the approved audio exactly. An audio reference alone must not be treated as a guarantee of exact speech.
Use real supplied screenshots for software demonstrations. Keep product details faithful to supplied assets.
CAPTIONS
Add captions after visual generation as real text layers:
Match the approved spoken {{LANGUAGE}}.
Use a readable {{LANGUAGE}} font such as Heebo.
Apply correct right-to-left layout.
Preserve punctuation and the order of mixed {{LANGUAGE}}, English, and numbers.
Show short phrases, with a maximum of two lines.
Use white text with a subtle dark outline or background.
Highlight occasional keywords in {{ACCENT_COLOR}}.
Keep captions clear of the presenter’s mouth and social-platform interface areas.
Synchronize captions with the final audio.
GRAPHIC LABELS
Add short {{LANGUAGE}} labels that reinforce the main points. Render them separately as stable text layers.
Use restrained rounded frames, subtle accent-color glow, and quick entrances. Avoid competing with captions or covering the presenter’s face.
EDITING AND SOUND
Use purposeful cuts, subtle push-ins, occasional changes in framing, and supporting visuals timed to the narration.
Use restrained transitions and light sound effects for meaningful reveals. Keep background music below the speech and reduce it further during dialogue.
Maintain consistent color, exposure, and audio levels across scenes.
AGENT WORKFLOW
Validate the script, references, and supporting assets.
Generate and check the {{LANGUAGE}} narration.
Measure its duration and plan the shots.
Generate clean visuals.
Apply lip-sync where required.
Assemble the video.
Add captions, labels, music, and sound effects.
Check the complete export and correct failed sections.
Use a dedicated {{LANGUAGE}} speech API and a separate text renderer when the selected Higgsfield workflow cannot reliably perform those steps. Report unavailable capabilities rather than silently substituting them.
FINAL QUALITY CHECK
Confirm:
Speech is understandable, natural {{LANGUAGE}} and matches the script.
Presenter identity and voice remain consistent.
Lip-sync follows the approved audio.
Captions are correctly spelled, timed, and displayed in RTL order.
All text remains stable between frames.
Demonstrations and product details are accurate.
Music never obscures speech.
Framing and text placement work on a phone.
The call to action is clear.
Deliver only after correcting failed checks. Identify anything that could not be verified.
