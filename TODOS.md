# TODOS

Deferred work from /plan-ceo-review (2026-04-01, main branch).

---

## P2 — 0-commit alerting

**What:** Add a runtime check after `getCommitsInRange()` in both `api/webhook.js`
and `api/gitlab-webhook.js` that sends a Slack/Teams warning when `commitCount === 0`.

**Why:** After the Phase 1+2 fix ships, validation requires manually reading Vercel
logs after each release. A 0-commit warning would catch silent failures automatically
before bad release notes get published to users. This directly addresses Premise 4
from the design doc — "no ground-truth verification layer."

**Context:** The fix improves tag selection correctness, but if something still goes
wrong (e.g., wrong tag range, API lag, unusual repo state), the only signal today is
a suspiciously short set of release notes. A 0-commit warning turns a silent failure
into a loud one. Slack/Teams integration already exists — this is a small addition.

**Pros:** Automatic, immediate signal. Same notification channel Louisa already uses.
**Cons:** False positive if a release genuinely has 0 commits (unlikely in practice).
**Effort:** M (human: ~4h / CC: ~15min)
**Depends on:** Phase 1+2 fix shipped and validated (so we know what "0 commits" looks like in practice)

---

## P3 — Release note regeneration script

**What:** A script (`scripts/regen-release.js`) that accepts a tag name and
regenerates release notes, writing the result back to the GitHub or GitLab release.

**Why:** After the fix ships, if the first release still looks wrong (edge case,
stale config, etc.), the only current option is pushing a new tag or manually
calling the webhook endpoint. A regen script reduces recovery cost from "tag gymnastics"
to "run a script."

**Context:** The backfill script pattern already exists in this repo
(`scripts/backfill-log.js`, `scripts/backfill-enrich.js`). A regen script follows
the same pattern: read env vars, call the APIs directly, write the result back.
Could also double as a manual test tool after the Phase 1+2 fix ships.

**Pros:** Operational safety net. Consistent with existing script patterns.
**Cons:** Needs access to the same env vars as production. Not an endpoint (no auth needed).
**Effort:** M (human: ~1 day / CC: ~30min)
**Depends on:** Phase 1+2 fix (so the script uses the same tag selection logic)

---

## P3 — Shared GitLab Tags utility

**What:** Extract the Tags API pagination + suffix filter logic from `lib/gitlab.js`
into a shared utility (`lib/gitlab-tags.js`) so `scripts/list-prod-tags.js` and
`lib/gitlab.js` use the same code.

**Why:** After the Phase 1+2 fix, both files will contain the same Tags API pagination
loop + `GITLAB_PROD_TAG_SUFFIX` filter. If the suffix default changes, both files need
updating. Single source of truth prevents drift.

**Context:** The fix intentionally mirrors `list-prod-tags.js` because that script
already has the right implementation. The duplication is minor today but could cause
confusion if someone updates one file and not the other.

**Pros:** DRY. Consistent behavior between scripts and production code.
**Cons:** Adds a new file. Small refactor risk.
**Effort:** S (human: ~30min / CC: ~5min)
**Depends on:** Phase 1+2 fix merged (so we know the exact shape of the shared logic)
