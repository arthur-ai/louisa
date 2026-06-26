import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the GitHub webhook signature (HMAC-SHA256).
 * Returns true if the payload signature matches our secret.
 */
export function verifyGitHubSignature(payload, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const expected = "sha256=" +
    createHmac("sha256", secret).update(payload).digest("hex");

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a Slack request signature (HMAC-SHA256 over `v0:timestamp:body`).
 *
 * Slack signs the raw request body, so `rawBody` must be the unparsed bytes
 * exactly as received. Rejects requests whose timestamp is more than 5 minutes
 * old to guard against replay.
 *
 * @param {string} rawBody   - raw request body string
 * @param {string} timestamp - X-Slack-Request-Timestamp header
 * @param {string} signature - X-Slack-Signature header (e.g. "v0=abc...")
 * @param {string} secret    - SLACK_SIGNING_SECRET
 * @returns {boolean}
 */
export function verifySlackSignature(rawBody, timestamp, signature, secret) {
  if (!timestamp || !signature || !secret) return false;

  // Reject stale requests (timestamp is in seconds).
  const fiveMinutes = 5 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const expected = "v0=" +
    createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
