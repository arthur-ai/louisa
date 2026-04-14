/**
 * GitHub App authentication for Louisa.
 *
 * Generates short-lived installation tokens (valid 1 hour) by:
 *   1. Building a JWT signed with the App's RSA private key (RS256)
 *   2. Exchanging the JWT for an installation token via the GitHub API
 *
 * Tokens are cached in memory for the lifetime of the Vercel container
 * (or GitHub Action runner), so most API calls skip the token exchange.
 *
 * Required env vars:
 *   GITHUB_APP_ID             — numeric App ID (e.g. 12345678)
 *   GITHUB_APP_PRIVATE_KEY    — PEM private key (literal newlines or \n-escaped)
 *   GITHUB_APP_INSTALLATION_ID — installation ID for the org or repo
 */

import { createSign } from "crypto";

// In-memory token cache — one token per process lifetime.
const _cache = { token: null, expiresAt: 0 };

/**
 * Build a signed JWT for the GitHub App.
 * Spec: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
function buildJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: String(appId) })).toString("base64url");
  const data     = `${header}.${payload}`;
  const sign     = createSign("RSA-SHA256");
  sign.update(data);
  const sig = sign.sign(privateKey, "base64url");
  return `${data}.${sig}`;
}

/**
 * Return a valid installation token, refreshing if expired.
 * Throws if App credentials are missing or the token exchange fails.
 */
export async function getInstallationToken() {
  // Return cached token with a 60-second safety buffer
  if (_cache.token && Date.now() < _cache.expiresAt - 60_000) {
    return _cache.token;
  }

  const appId          = process.env.GITHUB_APP_ID;
  const rawKey         = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (!appId || !rawKey || !installationId) {
    throw new Error(
      "GitHub App credentials not configured. " +
      "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID."
    );
  }

  // Vercel/Actions may store the key with literal \n — normalize to real newlines.
  const privateKey = rawKey.replace(/\\n/g, "\n");

  const jwt = buildJWT(appId, privateKey);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method:  "POST",
      headers: {
        Authorization:        `Bearer ${jwt}`,
        Accept:               "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  _cache.token     = data.token;
  _cache.expiresAt = new Date(data.expires_at).getTime();

  console.log(`Louisa: GitHub App token refreshed (expires ${data.expires_at})`);
  return _cache.token;
}
