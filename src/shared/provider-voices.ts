/** Provider built-ins are identifiers, not proof of account authorization. */
export const OPENAI_VOICES: string[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];
const LEGACY_OPENAI_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
];
export function openaiBuiltInVoices(model: string): readonly string[] {
  return ["tts-1", "tts-1-hd"].includes(model)
    ? LEGACY_OPENAI_VOICES
    : OPENAI_VOICES;
}
