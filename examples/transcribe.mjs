/**
 * Minimal example. Shows live progress, saves the result.
 *
 * Every option is spelled out explicitly (no reliance on defaults) so you can
 * see every knob transcribe() exposes.
 *
 *   node examples/transcribe.mjs
 */

import { SpeechRevolutions } from "../dist/esm/index.js";

// Reads the key from SPEECHREVOLUTIONS_API_KEY or STT_API_KEY.
const client = new SpeechRevolutions();

const result = await client.transcribe(
  "audio.mp3", // audio: local path, URL, bytes, or Blob
  {
    outputType: "json", // output format: txt | json | srt | vtt | docx | pdf
    wordTimestamps: true, // include per-word start/end times
    speakerLabels: true, // label who spoke each segment (alias: diarize)
    nltk: true, // restore punctuation & capitalization
    tier: "standard", // processing tier: standard | economy
    customVocabulary: undefined, // string[] of domain terms to bias toward, or undefined
    onProgress: undefined, // callback(ProgressEvent) for transcription %, or undefined
    onUploadProgress: undefined, // callback(ProgressEvent) for upload %, or undefined
    progress: true, // render live upload + transcription bars in the console
  },
);

const out = await result.save("output"); // writes output.<outputType>; returns the path
console.log(`Saved transcript to ${out}`);
