#!/usr/bin/env node
// Unit-tests the Slack @mention bot's pure logic — intent parsing, version
// normalization, release-range selection, signature verification, and Slack
// chunking. No API calls. Run: node scripts/test-version-range.js

import {
  parseMentionIntent,
  normalizeVersion,
  selectReleasesBetween,
  concatReleaseNotes,
} from "../lib/version-range.js";
import { verifySlackSignature } from "../lib/crypto.js";
import { chunkForSlack } from "../lib/slack.js";
import { createHmac } from "node:crypto";

let fail = 0;
const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + " " + name);
  if (!cond) fail++;
};

// ── intent parsing ──
let i = parseMentionIntent("give me platform changes between version 1.4.1892 and 1.4.2227");
ok("parse platform", i && i.product === "platform" && i.v1 === "1.4.1892" && i.v2 === "1.4.2227");
i = parseMentionIntent("engine changes from 2.1.0 to 2.4.0");
ok("parse engine", i && i.product === "engine" && i.v1 === "2.1.0" && i.v2 === "2.4.0");
ok("parse no product", parseMentionIntent("changes between 1.0.0 and 2.0.0") === null);
ok("parse one version", parseMentionIntent("platform changes since 1.0.0") === null);
i = parseMentionIntent("platform 1.4.1892-success-aws-prod-platform 1.4.2227-success-aws-prod-platform");
ok("parse full tags", i && i.v1.startsWith("1.4.1892"));

// ── normalize ──
ok("normalize platform appends", normalizeVersion("platform", "1.4.1", "-success-aws-prod-platform") === "1.4.1-success-aws-prod-platform");
ok("normalize platform keeps", normalizeVersion("platform", "1.4.1-success-aws-prod-platform", "-success-aws-prod-platform") === "1.4.1-success-aws-prod-platform");
ok("normalize engine strips v", normalizeVersion("engine", "v2.1.0") === "2.1.0");

// ── selectReleasesBetween (newest-first input) ──
const rel = [
  { name: "4.0", body: "d", date: new Date("2026-04-01") },
  { name: "3.0", body: "c", date: new Date("2026-03-01") },
  { name: "2.0", body: "b", date: new Date("2026-02-01") },
  { name: "1.0", body: "a", date: new Date("2026-01-01") },
];
let s = selectReleasesBetween(rel, "1.0", "4.0");
ok("range excludes from, includes to", s.ok && s.releases.map((r) => r.name).join(",") === "2.0,3.0,4.0" && s.from === "1.0" && s.to === "4.0");
s = selectReleasesBetween(rel, "4.0", "1.0");
ok("range swaps reversed", s.ok && s.from === "1.0" && s.to === "4.0");
s = selectReleasesBetween(rel, "2.0", "2.0");
ok("range same version errors", !s.ok);
s = selectReleasesBetween(rel, "9.9", "1.0");
ok("range missing version errors", !s.ok && /Couldn.t find/.test(s.error));
ok("concat labels sections", concatReleaseNotes([{ name: "2.0", body: "hi" }]).includes("## 2.0"));

// ── signature ──
const secret = "shh";
const ts = Math.floor(Date.now() / 1000).toString();
const body = "x=1";
const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
ok("sig valid", verifySlackSignature(body, ts, sig, secret) === true);
ok("sig tampered", verifySlackSignature("x=2", ts, sig, secret) === false);
ok("sig stale", verifySlackSignature(body, "100", sig, secret) === false);
ok("sig missing", verifySlackSignature(body, ts, "", secret) === false);

// ── chunking ──
const big = Array.from({ length: 50 }, (_, n) => "para " + n + " " + "z".repeat(100)).join("\n\n");
const chunks = chunkForSlack(big, 500);
ok("chunks under limit", chunks.every((c) => c.length <= 500) && chunks.length > 1);
ok("chunk short single", chunkForSlack("hello").length === 1);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
