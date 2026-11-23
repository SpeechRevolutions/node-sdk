/**
 * Stream an audio file as if it were live, printing partials and finals as they arrive.
 *
 *   npm install speechrevolutions ws
 *   SPEECHREVOLUTIONS_API_KEY=... node examples/stream-file.mjs call.mp3 en
 *
 * Leave out the language to have it detected. Needs ffmpeg for anything other than a 16 kHz mono
 * 16-bit WAV. The file streams in real time, as live audio would.
 */
import { SpeechRevolutions } from "speechrevolutions";

const [path, language] = process.argv.slice(2);
const client = new SpeechRevolutions();

const result = await client.streamFile(path, {
  language,
  onEvent: (e) => {
    if (e.type === "session.created") console.log(`session ${e.jobId}`);
    if (e.type === "transcription.partial") process.stdout.write(`\r\x1b[K${e.text ?? ""}`);
    if (e.type === "final") console.log(`\r\x1b[K[${e.start?.toFixed(2)}-${e.end?.toFixed(2)}] ${e.text}`);
    if (e.type === "final.revised") console.log(`   revised #${e.index}: ${e.text}`);
    if (e.type === "language.detected") console.log(`   language: ${e.language}`);
  },
});
console.log(`\n${result.finals.length} finals, job ${result.jobId}\n${result.text}`);
