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
