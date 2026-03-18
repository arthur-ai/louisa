# Louisa 🐶

**Automatic, AI-powered release notes for GitHub and GitLab — so your team never has to write them again.**

Louisa is a lightweight serverless bot that listens for new tags and releases on your GitHub or GitLab repos, analyzes the commits and pull/merge requests since the last release, and uses Claude to generate polished, user-facing release notes — published directly to your Releases page.

She also enriches every merged PR and MR in place — rewriting vague titles and sparse descriptions into a consistent, structured format so that the context developers already captured gets properly surfaced when it's time to generate notes and content.

No manual steps. No copy-pasting changelogs. Just push a tag and Louisa handles the rest.

Works with **GitHub**, **GitLab**, or **both simultaneously**. Use whichever fits your workflow.

---

## How It Works

```
PR/MR merged on GitHub or GitLab
        │
        ▼
Webhook fires ──► Vercel serverless function
        │
        ├─► Verifies webhook signature
        ├─► Fetches PR/MR title, description, commits, changed files, and review comments
        ├─► Calls Claude to rewrite the description into a structured schema
        │       (Summary / Problem / Solution / User Impact / Changed Areas / Type / Breaking Changes)
        └─► Writes enriched title + description back to the PR/MR on GitHub or GitLab

─────────────────────────────────────────────────────────────────

Tag pushed to GitHub or GitLab
        │
        ▼
Webhook fires ──► Vercel serverless function
        │
        ├─► Verifies webhook signature
        ├─► Fetches commits between this tag and the previous release
        ├─► Fetches merged PRs/MRs — now with enriched, structured descriptions
        ├─► Calls Claude via the Anthropic SDK to generate release notes
        ├─► Creates a published Release with formatted notes
        ├─► Posts a summary to Slack and/or Teams (optional)
        │       └─► Logs release metadata to ./logs/ for monthly blog drafting
        └─► Sends full OpenInference traces to Arthur Engine (optional)

─────────────────────────────────────────────────────────────────

  ╔══════════════════════════════════════════════════════════════╗
  ║  OPTIONAL: Monthly content pipelines (GitHub Actions)       ║
  ╚══════════════════════════════════════════════════════════════╝

On the 24th of each month — Blog Post Drafting:
        │
        ├─► Backfills release log from GitHub + GitLab APIs
        └─► Calls Claude to draft "What's New" blog post → artifact for team review

On the 28th of each month — Changelog Publishing:
        │
        ├─► Backfills release log from GitHub + GitLab APIs
        ├─► Calls Claude to synthesize combined changelog (Platform + Engine)
        ├─► Creates or updates entry on docs.arthur.ai/changelog via readme.io API
        └─► Posts Slack and/or Teams notification with link to the published changelog
```

Louisa handles multiple scenarios:

- **PR/MR merged (GitHub or GitLab)** — Louisa enriches the PR/MR description in place with structured context, improving the signal available for release notes and blog content downstream.
- **Tag push (GitHub or GitLab)** — Automatically creates a published release with generated notes. No one needs to touch the Releases page manually.
- **Manual release (GitHub)** — If someone creates a release by hand, Louisa detects it and fills in the release notes if they're empty.

---

## What You Get

### Core: PR/MR context enrichment

When a PR or MR is merged, Louisa automatically rewrites its title and description into a consistent, structured format — pulling from the original description, commit messages, changed files, and review comments to capture what developers already documented but rarely write up cleanly.

Each enriched description follows this schema:

| Field | What it captures |
|-------|-----------------|
| **Summary** | What was built and why, in plain English |
| **Problem** | The specific friction or gap being addressed |
| **Solution** | What was implemented |
| **User Impact** | Who benefits and how |
| **Changed Areas** | Files, services, and systems touched |
| **Type** | Feature / Bug Fix / Dependency / Internal / Breaking |
| **Breaking Changes** | Explicit flag — never omitted, never buried |

The enriched content is written back to the PR/MR on GitHub or GitLab. An invisible marker prevents re-enrichment if the webhook fires more than once.

This gives every downstream step — release notes, blog drafts, changelogs — substantially richer signal without requiring developers to change how they write PRs.

### Core: Automatic release notes

Louisa generates release notes on every tag push that are:

- **Grouped by product area** — not by change type. Sections like "Evaluation & Experiment Enhancements" instead of "Bug Fixes" and "Features."
- **Written for users** — every bullet leads with the benefit or capability, not the code change.
- **Clean and consistent** — follows a structured format with section summaries, bold feature names, and horizontal dividers.
- **Free of internal noise** — CI changes, merge commits, and refactors are filtered out automatically.

### Optional: Monthly content pipelines

Louisa also ships two optional GitHub Actions pipelines that build on the release notes she generates:

- **Blog Post Drafting** — On the 24th of each month, Claude drafts a "What's New" blog post from the month's releases. Instead of a PM manually reading through every release to write something for your blog, the draft arrives ready for a final editorial pass. Output is uploaded as a GitHub Actions artifact so the team can review, polish, and publish.

- **Changelog Publishing** — On the 28th of each month, Claude synthesizes a single structured changelog entry covering all products and publishes it directly to your developer docs via the readme.io API. No manual copy-pasting from multiple repos, no stale external changelog. A Slack/Teams notification fires once it's live.

These pipelines are **entirely optional** — they have no effect on Louisa's core release notes generation and require no extra setup unless you want them.

---

## Platform Support

| Feature | GitHub | GitLab |
|---------|--------|--------|
| PR/MR enrichment on merge | ✅ | ✅ |
| Tag push → auto-create release | ✅ | ✅ |
| Manual release → fill in notes | ✅ | — |
| Commit & PR/MR analysis | ✅ | ✅ |
| Slack notifications | ✅ | ✅ |
| Teams notifications | ✅ | ✅ |
| Arthur Engine tracing | ✅ | ✅ |
| Webhook signature verification | Secret token | Secret token |

You can use Louisa with GitHub only, GitLab only, or both at the same time. Each platform has its own webhook endpoint, API client, and Claude prompt — so release notes are generated independently and can be customized per product.

---

## Observability and evals powered by the Arthur Engine

> **Louisa ships with built-in AI observability via [Arthur Evals Engine](https://github.com/arthur-ai/arthur-engine).** Every release generation — from the first GitHub API call through the Claude response to the final Slack notification — is traced in full and sent to Arthur as OpenInference-compatible OTLP spans.

When Arthur is configured, you get a complete trace for every release:

```
louisa.github.release  [CHAIN]
│
├── github.get_previous_tag       [TOOL]   → "v1.4.2"
├── github.get_commits            [TOOL]   → 14 commits
├── github.get_pull_requests      [TOOL]   → 6 merged PRs
├── anthropic.messages.create     [LLM]    → claude-sonnet-4-20250514
│       input tokens: 3,847  output tokens: 812
│       system prompt, user message, full assistant response
├── github.create_release         [TOOL]   → https://github.com/…/releases/tag/v1.5.0
└── slack.post_notification       [TOOL]   → sent
```

**What Arthur captures automatically:**

| Signal | Details |
|--------|---------|
| LLM inputs & outputs | Full system prompt, user message, and generated release notes |
| Token usage | Prompt, completion, and cache token counts per request |
| Model metadata | Model name, provider, invocation parameters |
| Tool calls | Each GitHub / GitLab / Slack API call with inputs and outputs |
| Latency | Wall-clock duration of every span |
| Errors | Full error messages on any failed step |
| Session linking | All traces tied to your Louisa task in the Arthur dashboard |

Instrumentation uses the official [`@arizeai/openinference-instrumentation-anthropic`](https://arize-ai.github.io/openinference/js/packages/openinference-instrumentation-anthropic/) package, which automatically wraps the Anthropic SDK and emits LLM spans that follow the [OpenInference semantic conventions](https://github.com/Arize-ai/openinference/tree/main/spec).

**Tracing is fully optional.** If Arthur env vars are not set, Louisa silently skips all tracing — the release notes pipeline runs identically without it.

---

## Prerequisites

**Required:**
- A [Vercel](https://vercel.com) account (free tier works)
- An [Anthropic](https://console.anthropic.com) API key (for Claude)

**For GitHub repos:**
- A GitHub Personal Access Token with read/write access to contents and releases
- Admin access to the repo (to configure the webhook)

**For GitLab repos:**
- A GitLab Personal Access Token with `api` scope
- Maintainer access to the project (to configure the webhook)
- The GitLab project ID (found under project Settings → General, or via the Actions menu on the project page)

**Optional:**
- A [Slack](https://slack.com) workspace with an Incoming Webhook URL (for release notifications)
- A [Microsoft Teams](https://teams.microsoft.com) channel with an Incoming Webhook URL (for release notifications)
- An [Arthur Evals Engine](https://arthur.ai) account with a task configured (for AI observability)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/louisa.git
cd louisa
npm install
```

### 2. Configure environment variables

Create a `.env.local` file in the project root. Include only the variables for the platforms you're using:

```env
# ── Required ──
ANTHROPIC_API_KEY=sk-ant-your_anthropic_key

# ── GitHub (include if using GitHub) ──
GITHUB_TOKEN=ghp_your_github_token
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret
GITHUB_REPO_OWNER=your-org
GITHUB_REPO_NAME=your-repo

# ── GitLab (include if using GitLab) ──
GITLAB_TOKEN=glpat-your_gitlab_token
GITLAB_WEBHOOK_SECRET=your_gitlab_webhook_secret
GITLAB_PROJECT_ID=12345678

# ── Slack (optional) ──
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx

# ── Microsoft Teams (optional) ──
TEAMS_WEBHOOK_URL=https://your-org.webhook.office.com/webhookb2/xxx

# ── readme.io (optional — only needed for Monthly Changelog Publishing) ──
README_API_KEY=rdme_your_readme_api_key
README_AUTHOR_ID=your_readme_user_id

# ── Arthur Evals Engine (optional) ──
ARTHUR_BASE_URL=https://your-engine.arthur.ai
ARTHUR_API_KEY=your_arthur_api_key
ARTHUR_TASK_ID=your_task_id
```

To generate webhook secrets:

```bash
openssl rand -hex 32
```

**GitHub Token permissions** (fine-grained token):
- **Contents** — Read and write
- **Pull requests** — Read and write (required for PR enrichment — reading commits/files/comments, writing enriched descriptions back)
- Scoped to the repo you want release notes for

**GitLab Token permissions:**
- **Scope:** `api`
- Create at GitLab → User Settings → Access Tokens

**Anthropic API Key:**
- Create one at [console.anthropic.com](https://console.anthropic.com)

**Arthur Evals Engine:**
- `ARTHUR_BASE_URL` — the base URL of your Arthur Engine instance
- `ARTHUR_API_KEY` — your Arthur Engine API key (Bearer token)
- `ARTHUR_TASK_ID` — the task ID to link traces to (found in the Arthur dashboard); if omitted, Arthur auto-creates a task named `louisa`

**Slack Incoming Webhook (optional):**
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Choose **From scratch**, name it **Louisa**, and select your workspace
3. Go to **Incoming Webhooks** in the sidebar and toggle it on
4. Click **Add New Webhook to Workspace** and select your releases channel (e.g. #releases)
5. Copy the webhook URL and use it as `SLACK_WEBHOOK_URL`

**Microsoft Teams Incoming Webhook (optional):**
1. Open the Teams channel where you want notifications (e.g. **Releases**)
2. Click **···** (More options) → **Connectors** (classic connectors) **or** go to **Manage channel → Edit → Connectors**
   > **Note:** Microsoft is migrating to Workflows-based webhooks. If Connectors are unavailable, go to the channel → **···** → **Workflows** → search for **"Post to a channel when a webhook request is received"** and follow the prompts.
3. Find **Incoming Webhook**, click **Configure**, give it the name **Louisa**
4. Copy the generated webhook URL and use it as `TEAMS_WEBHOOK_URL`

You can configure Slack only, Teams only, or both simultaneously — Louisa posts to whichever are set.

### 3. Deploy to Vercel

```bash
vercel link
vercel --prod
```

Then add the same environment variables in the Vercel dashboard under **Project → Settings → Environment Variables**.

### 4. Configure webhooks

Set up webhooks on each repo you want Louisa to monitor. You can configure one or both.

**GitHub webhook:**

On your GitHub repo, go to **Settings → Webhooks → Add webhook**:
1. **Payload URL:** `https://your-vercel-domain.vercel.app/api/webhook`
2. **Content type:** `application/json`
3. **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
4. **Events:** Select "Let me select individual events" and check:
   - **Branch or tag creation** (triggers release creation on tag push)
   - **Releases** (triggers note generation on manual releases)
   - **Pull requests** (triggers PR enrichment on merge)

**GitLab webhook:**

On your GitLab project, go to **Settings → Webhooks → Add new webhook**:
1. **URL:** `https://your-vercel-domain.vercel.app/api/gitlab-webhook`
2. **Secret token:** the same value as `GITLAB_WEBHOOK_SECRET`
3. **Trigger:** Check only **Tag push events**

---

## Project Structure

```
louisa/
├── api/
│   ├── webhook.js            # GitHub webhook handler
│   └── gitlab-webhook.js     # GitLab webhook handler
├── lib/
│   ├── otel.js                # OpenTelemetry + OpenInference tracing setup
│   ├── github.js              # GitHub API client (commits, PRs, releases, enrichment)
│   ├── gitlab.js              # GitLab API client (commits, MRs, releases, enrichment)
│   ├── enrich.js              # PR/MR context enrichment — Claude prompt + idempotency guard
│   ├── claude.js              # Anthropic SDK client for GitHub release notes
│   ├── claude-platform.js     # Anthropic SDK client for GitLab release notes
│   ├── slack.js               # Slack Incoming Webhook client + monthly release logger
│   └── crypto.js              # GitHub webhook signature verification
├── scripts/
│   ├── backfill-enrich.js     # Retroactively enrich PRs merged since the last release
│   ├── backfill-log.js        # Seed monthly log from existing GitHub/GitLab releases
│   ├── draft-blog.js          # [optional] Generate monthly blog post from release logs
│   └── publish-changelog.js   # [optional] Publish combined monthly changelog to readme.io
├── .github/
│   └── workflows/
│       ├── draft-blog.yml          # [optional] Auto-drafts blog post on the 24th of each month
│       └── publish-changelog.yml   # [optional] Auto-publishes changelog to readme.io on the 28th
├── logs/                      # Monthly release logs — gitignored, created at runtime
├── output/                    # Generated blog drafts — gitignored, created at runtime
├── package.json
├── vercel.json
└── .env.local                  # Local environment variables (not committed)
```

---

## Architecture

| Component | Purpose |
|-----------|---------|
| `api/webhook.js` | Receives GitHub webhooks, routes tag, release, and pull_request merge events, orchestrates the GitHub pipeline |
| `api/gitlab-webhook.js` | Receives GitLab webhooks, handles tag push and merge_request merge events, orchestrates the GitLab pipeline |
| `lib/enrich.js` | Core enrichment logic — builds the Claude prompt from full PR/MR context, enforces the structured schema, guards against re-enrichment with an idempotency marker |
| `lib/otel.js` | Lazy-initialises the OpenTelemetry provider, patches the Anthropic SDK for auto-instrumentation, exports `getTracer`, `forceFlush`, and `activeSpan` |
| `lib/crypto.js` | Verifies GitHub webhook authenticity using HMAC-SHA256 with timing-safe comparison |
| `lib/github.js` | Compares tags, fetches commits/files/comments, resolves merged PRs, creates and updates GitHub releases, writes enriched PR descriptions |
| `lib/gitlab.js` | Compares tags, fetches commits/changes/notes, resolves merged MRs, creates GitLab releases, writes enriched MR descriptions |
| `lib/claude.js` | Anthropic SDK client with the Claude prompt tailored for GitHub product release notes |
| `lib/claude-platform.js` | Anthropic SDK client with the Claude prompt tailored for GitLab product release notes |
| `lib/slack.js` | Posts release notifications to Slack and/or Teams via `postReleaseNotification`; logs structured release metadata to `./logs/releases-{month}.json.lines` after each successful dispatch |
| `scripts/backfill-enrich.js` | Retroactively enriches all PRs merged since the last release — dry-run by default, `--write` to apply |
| `scripts/backfill-log.js` | *(optional pipeline)* Fetches published release note bodies from GitHub and GitLab APIs and writes structured log entries — no Claude calls, safe to re-run, deduplicates by tag |
| `scripts/draft-blog.js` | *(optional pipeline)* Reads monthly release log entries and calls Claude to draft a "What's New" blog post |
| `scripts/publish-changelog.js` | *(optional pipeline)* Reads monthly release logs, calls Claude to synthesize a combined changelog, creates or updates the entry on readme.io, and posts a Slack/Teams notification |

### Tracing architecture

`lib/otel.js` initialises once per serverless container:

1. Creates a `NodeTracerProvider` with an `OTLPTraceExporter` pointed at `ARTHUR_BASE_URL/api/v1/traces`
2. Calls `AnthropicInstrumentation.manuallyInstrument(Anthropic)` to patch the SDK class — from this point, every `client.messages.create()` call automatically emits a fully-attributed `LLM` span following the OpenInference spec
3. Registers the provider as the global OTel tracer

The webhook handlers wrap each logical step in an `activeSpan()` call (CHAIN for the overall pipeline, TOOL for each API call). Because OTel context propagation uses `AsyncLocalStorage`, when `generateReleaseNotes()` calls `client.messages.create()` inside an active CHAIN span, the auto-instrumented LLM span is automatically nested as a child — no manual wiring required.

---

## Notifications (Slack and/or Teams)

Louisa can post release summaries to **Slack**, **Microsoft Teams**, or both simultaneously. Configure either or both — each is independently optional.

When a notification channel is configured, Louisa automatically posts a summary every time release notes are published — from either GitHub or GitLab. Each message includes:

- The product name (auto-detected from the release notes)
- The release tag name
- The theme summary from the release notes
- A list of key areas covered in the release
- A warning if the release includes breaking changes
- A **"View Full Release Notes"** button linking directly to the GitHub or GitLab release

| Variable | Channel | Format |
|----------|---------|--------|
| `SLACK_WEBHOOK_URL` | Slack | Block Kit (header, sections, button) |
| `TEAMS_WEBHOOK_URL` | Microsoft Teams | Adaptive Card v1.2 |

If neither variable is set, Louisa skips notifications silently — everything else works as normal.

On the 28th of each month, the same channels also receive a notification linking to the newly published combined changelog on docs.arthur.ai.

---

## PR/MR Context Enrichment

Every time a PR (GitHub) or MR (GitLab) is merged, Louisa fetches its full context — original title, description, commits, changed files, and review comments — and rewrites the description using a structured schema. The enriched content is written back to the PR/MR automatically. No developer action required.

### Why this matters

Developers write PR descriptions under time pressure. Titles like `UP-3688 timezone select` or `NO_REF - Refactored deprecated definitions` carry almost no signal for release notes or content generation. Louisa uses what the developer *did* — the actual code changes, commit messages, and any review discussion — to reconstruct what they *meant*, and writes it back in a form the entire downstream pipeline can use.

### What gets enriched

| Before | After |
|--------|-------|
| `Up 3688 timezone select` | `Add timezone and time format preferences to user settings` |
| `NO_REF - Refactored deprecated definitions` | `Fix Pydantic deprecation warnings in schema definitions` |
| `feat: new create experiment modal` | `Add guided multi-step experiment creation modal` |

Dependency bumps and internal refactors are typed correctly (`Dependency` / `Internal`) so Louisa can weight them appropriately when generating release notes — they don't get treated as user-facing features.

### Backfilling historical PRs

To enrich PRs that were merged before this feature was enabled, use the backfill script:

```bash
set -a && source .env.local && set +a

# Preview what would be enriched (dry-run, no writes)
node scripts/backfill-enrich.js

# Apply enrichment to all unprocessed PRs since the last release
node scripts/backfill-enrich.js --write

# Limit to N PRs (useful for a first test run)
node scripts/backfill-enrich.js --write --limit 5

# Enrich from a specific date instead of the last release
node scripts/backfill-enrich.js --write --since 2026-02-01T00:00:00Z

# Target a different repo
node scripts/backfill-enrich.js --write --owner my-org --repo my-repo
```

The script skips PRs that are already enriched (idempotent — safe to re-run).

### Webhook requirement

The GitHub webhook on your target repo must have the **Pull requests** event enabled. GitLab webhook trigger events don't need any changes — merge request events are already included in the default trigger set.

---

## Optional: Monthly Blog Post Drafting

> **This is an optional pipeline.** It has no effect on Louisa's core release notes generation. Enable it if your team publishes a monthly "What's New" blog post and wants a first draft written automatically.

Writing a monthly product blog post manually means a PM has to track down every release, read through the notes, and write something coherent that speaks to users rather than commit history — every single month. With multiple products and repos, that's a meaningful time sink just to produce a first draft.

Louisa solves this by accumulating structured metadata as she generates release notes each month. After each release notification fires, she logs the tag, product, theme, key areas, and the full generated notes to a monthly file at `./logs/releases-{month}.json.lines`. On the 24th of each month, a GitHub Action reads those entries and calls Claude to draft a polished "What's New" post. The draft lands in `output/blog-draft-{month}.md` and is uploaded as a GitHub Actions artifact — ready for a final editorial pass, not a blank page.

### Run it manually

```bash
# 1. Seed the log from the last 30 days of already-published releases
#    (reads existing release note bodies — no Claude calls, safe to re-run)
node scripts/backfill-log.js <github-owner> <github-repo> --days 30

# 2. Generate the blog draft
node scripts/draft-blog.js "March 2026" --days 30
# Output: output/blog-draft-march-2026.md
```

### Automated via GitHub Actions

`.github/workflows/draft-blog.yml` triggers automatically on the 24th of each month. It runs the backfill step first (to catch any releases that happened since the last log write), then drafts the post.

**Required secrets:** `ANTHROPIC_API_KEY`, `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`, `REPO_OWNER`, `REPO_NAME`

You can also trigger it manually from the **Actions** tab with an optional month override (e.g. `"February 2026"`).

---

## Optional: Monthly Changelog Publishing

> **This is an optional pipeline.** It has no effect on Louisa's core release notes generation. Enable it if you maintain a public-facing developer changelog (e.g. on readme.io) and want it updated automatically every month.

If you ship across multiple repos and products, keeping an external changelog current is a coordination problem. Someone has to manually aggregate releases from GitHub, GitLab, or wherever else your code lives, write a combined summary that reads consistently, and update the entry on your docs site. Do it late and your changelog goes stale. Do it manually every month and it becomes a recurring chore.

Louisa eliminates this entirely. On the 28th of each month, a GitHub Action pulls all releases logged during the month from both Arthur Platform (GitLab) and Arthur Engine & Toolkit (GitHub), calls Claude to synthesize a single structured entry organized by product, and creates or updates the entry on [docs.arthur.ai/changelog](https://docs.arthur.ai/changelog) via the readme.io API — attributed to your team's account, published immediately. A Slack/Teams notification fires once it's live so the team knows without having to check.

If any late-month releases fall on the 29th–31st, re-trigger the workflow manually to update the entry in place.

### Run it manually

```bash
# 1. Seed the log (if not already done)
node scripts/backfill-log.js <github-owner> <github-repo> --days 30

# 2. Publish to readme.io
set -a && source .env.local && set +a
node scripts/publish-changelog.js "March 2026"
# Output: creates or updates "March 2026 Release Notes" on docs.arthur.ai/changelog
```

### Automated via GitHub Actions

`.github/workflows/publish-changelog.yml` triggers automatically on the 28th of each month. It runs the backfill step first, then publishes.

**Required secrets:** `ANTHROPIC_API_KEY`, `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`, `README_API_KEY`, `README_AUTHOR_ID`, `REPO_OWNER`, `REPO_NAME`
**Optional secrets:** `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL` (at least one recommended)

You can also trigger it manually from the **Actions** tab with an optional month override (e.g. `"February 2026"`).

> **`README_AUTHOR_ID`** is your readme.io user ID — changelog entries are attributed to this account. Find it by checking an existing entry you created via the readme.io dashboard.

---

## Customizing the Release Notes Format

Each product has its own Claude prompt, so you can customize them independently:

- **GitHub product:** Edit the `systemPrompt` in `lib/claude.js`
- **GitLab product:** Edit the `systemPrompt` in `lib/claude-platform.js`

You can customize:

- **Grouping** — Change how changes are categorized (by product area, by change type, etc.)
- **Tone** — Adjust from marketing-forward to technical, conversational, or minimal
- **Structure** — Modify the heading format, section dividers, summary paragraphs, etc.
- **Filtering** — Control which types of changes are included or excluded

---

## Adding Another Repo

To add Louisa to a new repo:

**For a GitHub repo:**
1. Ensure the `GITHUB_TOKEN` has access to the new repo
2. Add a webhook on the new repo pointing to `/api/webhook` with the same secret
3. Louisa uses the webhook payload to identify the repo, so no code changes are needed

**For a GitLab project:**
1. Create a new GitLab token (or ensure the existing one has access)
2. Add the `GITLAB_PROJECT_ID` for the new project (or update the webhook handler to read it from the payload)
3. Add a webhook on the new project pointing to `/api/gitlab-webhook`

---

## Updating Louisa

After making code changes:

```bash
git add -A
git commit -m "Your change description"
git push origin main
```

If auto-deploy is configured, Vercel picks it up automatically. Otherwise:

```bash
vercel --prod
```

---

## Troubleshooting

**Webhook returns 401 (Invalid signature/token)**
The webhook secret in Vercel doesn't match the secret configured on the GitHub or GitLab webhook. Make sure they're identical.

**Release notes aren't appearing**
Check the Vercel function logs at **vercel.com → Project → Deployments → Latest → Functions**. Common causes:
- Token doesn't have write access to the target repo/project
- Environment variables aren't set in Vercel (or weren't redeployed after adding them)
- The webhook isn't firing the right events (check Recent Deliveries on GitHub or Recent Events on GitLab)

**Notes appear but are empty or generic**
This usually means 0 commits were found between tags. Check that the previous release tag exists and that commits were made between the two tags.

**Duplicate releases**
Louisa checks for existing releases before creating one and skips if notes are already present. If you see duplicates, ensure the webhook isn't configured on multiple repos or that multiple webhook entries don't exist for the same URL.

**Slack notification not posting**
Verify `SLACK_WEBHOOK_URL` is set in Vercel and the Incoming Webhook is still active in your Slack app settings. Check Vercel logs for `Louisa: Slack post failed` messages.

**Teams notification not posting**
Verify `TEAMS_WEBHOOK_URL` is set in Vercel. If using classic Connectors, check that the connector hasn't expired or been removed from the channel. If using Workflows-based webhooks, verify the flow is enabled. Check Vercel logs for `Louisa: Teams post failed` messages.

**PR/MR descriptions aren't being enriched**
- Confirm the **Pull requests** event is checked on the GitHub webhook (Settings → Webhooks → Edit → individual events). GitLab requires no changes.
- Confirm the GitHub token has **Pull requests: Read and write** permission (fine-grained PAT).
- Check Vercel function logs for `Louisa: enrich` messages — the enrichment step logs its outcome.
- If a PR was already enriched, the idempotency marker (`<!-- enriched-by-louisa -->`) prevents re-processing. Remove it from the description to force a re-run.

**No traces appearing in Arthur Engine**
- Verify `ARTHUR_BASE_URL` and `ARTHUR_API_KEY` are set in Vercel and match your Arthur instance
- Check Vercel logs for `Louisa: Arthur trace failed` or `Louisa: trace flush error` messages
- Ensure the Vercel function timeout (`maxDuration: 60`) is long enough for `forceFlush()` to complete before the container is recycled
- Arthur auto-creates a task named `louisa` on first trace receipt — look for it in the Arthur dashboard if you haven't set `ARTHUR_TASK_ID`

---

## How It's Built

- **Runtime:** Node.js (ES modules) on Vercel Serverless Functions
- **AI:** Claude Sonnet via the [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) official TypeScript/JavaScript SDK
- **Observability:** OpenTelemetry SDK + [`@arizeai/openinference-instrumentation-anthropic`](https://arize-ai.github.io/openinference/js/packages/openinference-instrumentation-anthropic/) for automatic LLM span instrumentation, OTLP/proto export to [Arthur Evals Engine](https://arthur.ai)
- **APIs:** GitHub REST API v3 and GitLab REST API v4 (direct fetch, no SDKs)
- **Auth:** Secret token (GitHub), secret token (GitLab), Bearer/Private tokens for API calls
- **Notifications:** Slack Incoming Webhooks, Microsoft Teams Adaptive Cards (Incoming Webhooks)

---

## License

MIT

---

<p align="center">
  Built with ❤️ by <a href="https://www.ashleynader.com">Ashley Nader</a>
  <br>
  <em>README.md generated by Louisa 🐶</em>
</p>
