# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Louisa is

Louisa is a Vercel serverless bot that generates AI release notes for Arthur. It handles two separate pipelines that share the same enrichment library:

- **GitHub (Arthur Engine):** tag push → `api/webhook.js` → `lib/github.js` → `lib/claude.js` → GitHub Release
- **GitLab (Arthur Platform):** tag push → `api/gitlab-webhook.js` → `lib/gitlab.js` → `lib/claude-platform.js` → GitLab Release

Additionally, when a PR/MR is *merged* (before any tag push), both webhooks enrich the PR/MR title and description in place via `lib/enrich.js`. This enriched content is then available when release notes are generated.

## Running locally

```bash
npm install
vercel dev   # serves api/ as serverless functions at localhost:3000
```

No test runner exists. Logic is validated by running scripts directly. All scripts need env vars loaded first:

```bash
set -a && source .env.local && set +a
node scripts/list-prod-tags.js       # verify GitLab tag sort logic
node scripts/test-tag-sort.js        # unit-test tag sort algorithm (no API calls)
node scripts/backfill-enrich.js      # dry-run enrichment backfill
node scripts/backfill-enrich.js --write  # actually write to GitHub PRs
```

## Deploying

```bash
vercel deploy --prod
```

Env var changes take effect on next deployment. Secrets live in Vercel dashboard, not in any committed file.

## Environment variables

**GitHub pipeline:**
- `GITHUB_TOKEN` — PAT with repo read/write
- `GITHUB_WEBHOOK_SECRET` — HMAC secret for `api/webhook.js`
- `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` — target repo for scripts

**GitLab pipeline:**
- `GITLAB_TOKEN` — PAT with API access
- `GITLAB_WEBHOOK_SECRET` — token verified in `api/gitlab-webhook.js`
- `GITLAB_PROJECT_ID` — primary GitLab project ID (numeric)
- `GITLAB_SCOPE_PROJECT_ID` — optional second project (frontend); when set, commits and MRs from both projects are merged into one set of release notes
- `GITLAB_PROD_TAG_SUFFIX` — suffix that identifies production tags (default: `-success-aws-prod-platform`); must be non-empty or it matches every tag

**Shared:**
- `ANTHROPIC_API_KEY`

**Tracing (optional — skipped silently if absent):**
- `ARTHUR_BASE_URL`, `ARTHUR_API_KEY`, `ARTHUR_TASK_ID`

**Notifications (optional):**
- `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`

## Architecture: how release notes are generated

### Previous tag selection (known bug, fix in progress)

`getPreviousReleaseTag()` in both `lib/github.js` and `lib/gitlab.js` currently sorts by release *publish date* from the Releases API — which is fragile and breaks on out-of-order or backdated releases. The correct fix is to use the Tags API and sort by commit date. See `scripts/list-prod-tags.js` for the reference implementation that already does this correctly for GitLab.

### GitLab dual-repo pattern

When `GITLAB_SCOPE_PROJECT_ID` is set, `api/gitlab-webhook.js` fetches commits and MRs from both the primary project and the scope project in parallel, then merges them before passing to Claude. This is how Platform release notes include frontend changes alongside backend changes.

### PR/MR enrichment

On every PR/MR merge event, Louisa rewrites the title and description in place using `lib/enrich.js`. The enriched description uses a structured schema (`## Summary`, `## Problem`, `## User Impact`, `## Type`, etc.) that Claude then reads during release note generation. An invisible `<!-- enriched-by-louisa -->` marker prevents re-enrichment.

**GitLab webhook must have "Merge request events" enabled** (not just "Tag push events") for enrichment to fire. This is a common misconfiguration.

### Tracing

Every significant API call is wrapped in `activeSpan()` from `lib/otel.js`, which sends OpenInference-compatible OTLP spans to Arthur Engine. Tracing is additive — removing or disabling it doesn't change pipeline behavior.

### Monthly pipeline

`lib/slack.js` logs structured release metadata to `./logs/releases-{month}.json.lines` after each successful release notification. GitHub Actions on the 24th draft a blog post (`scripts/draft-blog.js`) and on the 28th publish a changelog (`scripts/publish-changelog.js`).

## Key constraints

- **60-second max per function invocation** (Vercel serverless limit). GitLab tag pagination must be capped to avoid timeout.
- **ESM only** (`"type": "module"` in package.json). All imports use `.js` extensions.
- **No persistent storage** on the serverless layer. `logs/` files are written during local script runs or GitHub Actions, not by the Vercel functions.

## Tag filtering

GitHub: tags containing `-dev` or starting with `sdk-` are skipped in `api/webhook.js`.
GitLab: only tags matching `GITLAB_PROD_TAG_SUFFIX` are processed — checked at the top of `api/gitlab-webhook.js` before any API calls.

## Prompt/LLM changes

When modifying prompts in `lib/claude.js`, `lib/claude-platform.js`, or `lib/enrich.js`, verify with a real trace in Arthur Engine. The grounding rule ("only include information present in the provided data") is intentional — do not remove it. Changes to the enrichment schema in `lib/enrich.js` affect downstream release note quality since Claude reads that structured content.
