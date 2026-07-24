/**
 * Webhooks: get notified when a job finishes instead of waiting.
 *
 * Pass `callbackUrl` and the platform POSTs a signed JSON notification on
 * completion/failure:
 *   { job_id, status: "completed"|"failed", download_url?, step?, reason? }
 * signed with HMAC-SHA256 over the raw body in `X-SR-Signature: sha256=<hex>`.
 *
 *   node examples/webhooks.mjs
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { SpeechRevolutions } from "../dist/esm/index.js";

// --- 1. Submit a job with a webhook ----------------------------------------
const client = new SpeechRevolutions(); // reads SPEECHREVOLUTIONS_API_KEY
await client.transcribe("audio.mp3", {
  callbackUrl: "https://your-app.example.com/webhooks/speechrevolutions",
});
console.log("Submitted. Your callbackUrl will be POSTed when the job finishes.");

// --- 2. Verify an incoming webhook (Express handler) -----------------------
// Compare against the RAW body bytes, using a constant-time comparison.
export function verifySignature(rawBody, signatureHeader, signingSecret) {
  const expected =
    "sha256=" + createHmac("sha256", signingSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

// import express from "express";
// const app = express();
// const SECRET = process.env.SR_WEBHOOK_SECRET;      // same secret configured server-side
// // NOTE: capture the raw body for signature verification.
// app.post(
//   "/webhooks/speechrevolutions",
//   express.raw({ type: "application/json" }),
//   (req, res) => {
//     if (!verifySignature(req.body, req.get("X-SR-Signature"), SECRET))
//       return res.status(401).send("bad signature");
//     const event = JSON.parse(req.body.toString());
//     if (event.status === "completed") {
//       // mark done in your DB; fetch event.download_url
//     } else {
//       // event.status === "failed": event.step, event.reason
//     }
//     res.json({ ok: true });                          // 2xx = delivered (we retry on 5xx)
//   },
// );
