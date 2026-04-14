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
Webhook fires ──► Vercel serverless function (fast path, < 5s)
        │
        ├─► Verifies webhook signature
        ├─► Fetches PR/MR title, description, commits, changed files, and review comments
        ├─► Calls Claude Haiku to generate a compact structured summary
        │       (summary / type / user impact)
        ├─► Appends summary to logs/pr-summaries.jsonl
        └─► Rewrites the PR/MR description with a structured enrichment schema
                (Summary / Problem / Solution / User Impact / Changed Areas / Type / Breaking Changes)

─────────────────────────────────────────────────────────────────

Tag pushed to GitHub or GitLab
        │
        ▼
Webhook fires ──► Vercel serverless function (thin dispatcher, < 5s)
        │
        ├─► Verifies webhook signature
        ├─► Checks if release already exists (idempotency)
        └─► Dispatches repository_dispatch event to GitHub Actions

                ▼

        GitHub Action picks up the event (no time limit)
        │
        ├─► Reads pre-computed PR/MR summaries from logs/pr-summaries.jsonl
        ├─► Summarizes any PRs/MRs not yet in the log (using Claude Haiku)
        ├─► Calls Claude Opus to generate polished release notes from the summaries
        ├─► Creates a published Release with formatted notes
        ├─► Posts a summary to Slack and/or Teams (optional)
        │       └─► Logs release metadata to ./logs/ for monthly blog drafting
        ├─► Commits updated logs/pr-summaries.jsonl back to the repo
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

- **PR/MR merged (GitHub or GitLab)** — Louisa summarizes the PR/MR into a compact log entry and enriches the description in place. Both happen in a single fast webhook call.
- **Tag push (GitHub or GitLab)** — The webhook immediately dispatches a GitHub Action. The Action generates release notes without any time limit, using pre-computed summaries to keep prompts lean.
- **Manual release (GitHub)** — If someone creates a release by hand, Louisa detects it and fills in the release notes if they're empty.

---

## Why GitHub Actions for Release Generation?

Vercel serverless functions have a **60-second maximum execution time**. For a release window covering many PRs, fetching context and calling Claude can easily exceed this — causing silent failures where the webhook fires but no release appears.

Louisa solves this by splitting the work:

| Step | Where | Why |
|------|-------|-----|
| Webhook validation + idempotency check | Vercel (< 2s) | Needs to respond to GitHub/GitLab quickly |
| PR/MR summarization at merge time | Vercel (< 10s) | One PR at a time — always fast |
| Release note generation | GitHub Action (no limit) | May need to summarize dozens of PRs + call Opus |

The GitHub Action also commits `logs/pr-summaries.jsonl` back to the repo after each run, so summaries accumulate over time and future releases skip PRs that are already in the log.

---

## Two-Model Strategy

| Task | Model | Why |
|------|-------|-----|
| Per-PR/MR summarization | `claude-haiku-4-5` | ~10× faster and cheaper; output is 2-3 sentences |
| Release notes generation | `claude-opus-4-6` | Richer synthesis; runs once per tag in a GitHub Action |

Haiku also uses [tool use](https://docs.anthropic.com/en/docs/tool-use) with a strict schema — this guarantees structured JSON output without needing to parse free-form text or strip markdown code fences.

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

Simultaneously, a compact structured summary (2-3 sentences + type + user impact) is appended to `logs/pr-summaries.jsonl` — a persistent log that release note generation reads instead of re-analysing every PR from scratch.

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
| Per-PR/MR summary log | ✅ | ✅ |
| Tag push → GitHub Action dispatch | ✅ | ✅ |
| Manual release → fill in notes | ✅ | — |
| Commit & PR/MR analysis | ✅ | ✅ |
| Dual-repo support (frontend + backend) | — | ✅ |
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
├── anthropic.messages.create     [LLM]    → claude-opus-4-6
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

**For GitHub Actions (both pipelines):**
- The Louisa repo itself must have a `LOUISA_GITHUB_TOKEN` secret — a GitHub PAT with write access to the target repos (same token as `GITHUB_TOKEN` in Vercel). This is needed because the built-in `GITHUB_TOKEN` in Actions only has access to the Louisa repo itself, not to `arthur-engine` or other target repos.

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
GITHUB_TOKEN=github_pat_your_github_token
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret
GITHUB_REPO_OWNER=your-org
GITHUB_REPO_NAME=your-repo

# ── GitLab (include if using GitLab) ──
GITLAB_TOKEN=glpat-your_gitlab_token
GITLAB_WEBHOOK_SECRET=your_gitlab_webhook_secret
GITLAB_PROJECT_ID=12345678
GITLAB_PROD_TAG_SUFFIX=-success-aws-prod-platform  # suffix that identifies production tags

# ── Louisa self-reference (required for GitHub Action dispatch) ──
LOUISA_GITHUB_REPO=your-org/louisa  # e.g. arthur-ai/louisa

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

**`LOUISA_GITHUB_REPO`:**
Set this to the `owner/repo` of the Louisa repo itself (e.g. `arthur-ai/louisa`). Vercel uses it to dispatch `repository_dispatch` events to GitHub Actions when a tag is pushed.

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

### 3. Add GitHub Actions secrets

In the Louisa repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|--------|-------|
| `LOUISA_GITHUB_TOKEN` | The same PAT as `GITHUB_TOKEN` in Vercel — needs write access to target repos |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `GITLAB_TOKEN` | Your GitLab PAT (if using GitLab pipeline) |
| `GITLAB_PROD_TAG_SUFFIX` | Your GitLab prod tag suffix (if using GitLab pipeline) |
| `SLACK_WEBHOOK_URL` | Optional — for release notifications |
| `TEAMS_WEBHOOK_URL` | Optional — for release notifications |
| `ARTHUR_BASE_URL` | Optional — for tracing |
| `ARTHUR_API_KEY` | Optional — for tracing |
| `ARTHUR_TASK_ID` | Optional — for tracing |

### 4. Deploy to Vercel

```bash
vercel link
vercel --prod
```

Then add the same environment variables in the Vercel dashboard under **Project → Settings → Environment Variables**. Env var changes take effect on the next deployment.

### 5. Configure webhooks

Set up webhooks on each repo you want Louisa to monitor. You can configure one or both.

**GitHub webhook:**

On your GitHub repo, go to **Settings → Webhooks → Add webhook**:
1. **Payload URL:** `https://your-vercel-domain.vercel.app/api/webhook`
2. **Content type:** `application/json`
3. **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
4. **Events:** Select "Let me select individual events" and check:
   - **Branch or tag creation** (triggers release creation on tag push)
   - **Releases** (triggers note generation on manual releases)
   - **Pull requests** (triggers PR summarization and enrichment on merge)

**GitLab webhook:**

On your GitLab project, go to **Settings → Webhooks → Add new webhook**:
1. **URL:** `https://your-vercel-domain.vercel.app/api/gitlab-webhook`
2. **Secret token:** the same value as `GITLAB_WEBHOOK_SECRET`
3. **Triggers:** Check the following events:
   - **Tag push events** (triggers release note generation)
   - **Merge request events** (triggers MR summarization and enrichment on merge)

> **Important:** Both "Tag push events" and "Merge request events" must be enabled on the GitLab webhook. Merge request events fire the per-MR summarization that populates `logs/pr-summaries.jsonl` — without it, every tag push will need to re-summarize all MRs from scratch.

---

## Project Structure

```
louisa/
├── api/
│   ├── webhook.js            # GitHub webhook handler (dispatches to GitHub Action on tag push)
│   ├── gitlab-webhook.js     # GitLab webhook handler (dispatches to GitHub Action on tag push)
│   └── release-status.js     # Vercel cron — polls in-progress GitHub Action runs every 4 min
├── lib/
│   ├── otel.js                # OpenTelemetry + OpenInference tracing setup
│   ├── github.js              # GitHub API client (commits, PRs, releases, enrichment)
│   ├── gitlab.js              # GitLab API client (commits, MRs, releases, enrichment)
│   ├── enrich.js              # PR/MR context enrichment — Claude prompt + idempotency guard
│   ├── claude.js              # summarizePR (Haiku + tool use) + generateReleaseNotes (Opus)
│   ├── claude-platform.js     # generatePlatformReleaseNotes (Opus) — GitLab product prompt
│   ├── summaries.js           # Read/write helpers for logs/pr-summaries.jsonl
│   ├── slack.js               # Slack Incoming Webhook client + monthly release logger
│   └── crypto.js              # GitHub webhook signature verification
├── scripts/
│   ├── generate-github-release.js  # Full GitHub pipeline (summarize + generate + create release)
│   ├── generate-release-notes.js   # Full GitLab pipeline (summarize + generate + create release)
│   ├── backfill-releases.js        # Scan for missing releases; run generate script per tag
│   ├── backfill-enrich.js          # Retroactively enrich PRs merged since the last release
│   ├── backfill-log.js             # Seed monthly log from existing GitHub/GitLab releases
│   ├── draft-blog.js               # [optional] Generate monthly blog post from release logs
│   └── publish-changelog.js        # [optional] Publish combined monthly changelog to readme.io
├── .github/
│   └── workflows/
│       ├── generate-github-release.yml  # Triggered by GitHub tag push → creates GitHub release
│       ├── generate-release.yml         # Triggered by GitLab tag push → creates GitLab release
│       ├── draft-blog.yml               # [optional] Auto-drafts blog post on the 24th
│       └── publish-changelog.yml        # [optional] Auto-publishes changelog on the 28th
├── logs/
│   └── pr-summaries.jsonl     # Persistent per-PR/MR summaries log — committed to repo
├── output/                    # Generated blog drafts — gitignored, created at runtime
├── package.json
├── vercel.json
└── .env.local                  # Local environment variables (not committed)
```

---

## Architecture

| Component | Purpose |
|-----------|---------|
| `api/webhook.js` | Receives GitHub webhooks; dispatches GitHub Action on tag push; runs PR summarization + enrichment inline on merge |
| `api/gitlab-webhook.js` | Receives GitLab webhooks; dispatches GitHub Action on tag push; runs MR enrichment inline on merge |
| `api/release-status.js` | Vercel cron (every 4 min) — polls GitHub Actions API for in-progress release runs and logs step-level status |
| `lib/summaries.js` | Read/write helpers for `logs/pr-summaries.jsonl` — `appendSummary`, `readSummariesInRange`, `readSummariesForTag` |
| `lib/enrich.js` | Core enrichment logic — builds the Claude prompt from full PR/MR context, enforces the structured schema, guards against re-enrichment with an idempotency marker |
| `lib/otel.js` | Lazy-initialises the OpenTelemetry provider, patches the Anthropic SDK for auto-instrumentation, exports `getTracer`, `forceFlush`, and `activeSpan` |
| `lib/crypto.js` | Verifies GitHub webhook authenticity using HMAC-SHA256 with timing-safe comparison |
| `lib/github.js` | Compares tags, fetches commits/files/comments, resolves merged PRs, creates and updates GitHub releases, writes enriched PR descriptions |
| `lib/gitlab.js` | Compares tags, fetches commits/changes/notes, resolves merged MRs, creates GitLab releases, writes enriched MR descriptions |
| `lib/claude.js` | `summarizePR` (Haiku + tool use, structured JSON output) and `generateReleaseNotes` (Opus, GitHub product prompt) |
| `lib/claude-platform.js` | `generatePlatformReleaseNotes` (Opus, GitLab product prompt) |
| `lib/slack.js` | Posts release notifications to Slack and/or Teams; logs structured release metadata for the monthly pipelines |
| `scripts/generate-github-release.js` | Called by the GitHub Action — summarizes PRs not yet in log, generates release notes, creates the GitHub release |
| `scripts/generate-release-notes.js` | Called by the GitHub Action — summarizes MRs not yet in log, generates release notes, creates the GitLab release |
| `scripts/backfill-releases.js` | Scans for tags with no release; runs the generate script sequentially per missing tag (dry-run by default) |

### Summaries log

`logs/pr-summaries.jsonl` is a newline-delimited JSON file committed to the repo. Each line is one PR/MR summary:

```json
{
  "platform": "github",
  "repo": "arthur-ai/arthur-engine",
  "number": 1234,
  "title": "Add timezone preferences to user settings",
  "summary": "Adds per-user timezone and time format preferences...",
  "type": "Feature",
  "userImpact": "Users can now see all timestamps in their local timezone.",
  "author": "jsmith",
  "labels": ["feature"],
  "url": "https://github.com/...",
  "mergedAt": "2026-04-10T14:22:00Z",
  "tag": "2.1.516"
}
```

When a tag push triggers the GitHub Action, it reads this file first. Any PRs/MRs already summarized are skipped — only new ones are sent to Claude. This keeps prompts lean and generation fast regardless of how many total PRs exist in the repo.

### Tracing architecture

`lib/otel.js` initialises once per serverless container:

1. Creates a `NodeTracerProvider` with an `OTLPTraceExporter` pointed at `ARTHUR_BASE_URL/api/v1/traces`
2. Calls `AnthropicInstrumentation.manuallyInstrument(Anthropic)` to patch the SDK class — from this point, every `client.messages.create()` call automatically emits a fully-attributed `LLM` span following the OpenInference spec
3. Registers the provider as the global OTel tracer

The webhook handlers wrap each logical step in an `activeSpan()` call (CHAIN for the overall pipeline, TOOL for each API call). Because OTel context propagation uses `AsyncLocalStorage`, when `generateReleaseNotes()` calls `client.messages.create()` inside an active CHAIN span, the auto-instrumented LLM span is automatically nested as a child — no manual wiring required.

---

## Running Locally

```bash
npm install
vercel dev   # serves api/ as serverless functions at localhost:3000
```

Load env vars before running scripts:

```bash
set -a && source .env.local && set +a
```

Key scripts:

```bash
# Check which GitLab tags are missing releases (dry-run)
node scripts/backfill-releases.js

# Run the full pipeline for a specific GitLab tag
node scripts/generate-release-notes.js \
  --tag 1.4.1987-success-aws-prod-platform \
  --project-id 48008591

# Run the full pipeline for a specific GitHub tag
node scripts/generate-github-release.js \
  --owner arthur-ai \
  --repo arthur-engine \
  --tag 2.1.516

# Verify tag sort logic (GitLab)
node scripts/list-prod-tags.js

# Unit-test tag sort algorithm (no API calls)
node scripts/test-tag-sort.js

# Retroactively enrich PRs (dry-run)
node scripts/backfill-enrich.js

# Retroactively enrich PRs (write)
node scripts/backfill-enrich.js --write
```

---

## Backfilling Missed Releases

If a release was skipped (e.g. due to a timeout before the GitHub Action migration), use the backfill script to identify gaps and re-run the pipeline:

```bash
set -a && source .env.local && set +a

# List missing GitLab releases (dry-run)
node scripts/backfill-releases.js

# Run generate for all missing tags (oldest-first)
node scripts/backfill-releases.js --run
```

For individual tags, you can also trigger from the GitHub Actions UI:
- **GitLab tag:** Actions → **Generate Release Notes** → Run workflow → enter tag
- **GitHub tag:** Actions → **Generate GitHub Release Notes** → Run workflow → enter owner, repo, tag

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

- **GitHub product:** Edit the `systemPrompt` in `lib/claude.js` → `generateReleaseNotes`
- **GitLab product:** Edit the `systemPrompt` in `lib/claude-platform.js` → `generatePlatformReleaseNotes`

You can customize:

- **Grouping** — Change how changes are categorized (by product area, by change type, etc.)
- **Tone** — Adjust from marketing-forward to technical, conversational, or minimal
- **Structure** — Modify the heading format, section dividers, summary paragraphs, etc.
- **Filtering** — Control which types of changes are included or excluded

> When modifying prompts, verify results with a real trace in Arthur Engine. The grounding rule ("only include information present in the provided data") is intentional — do not remove it.

---

## Troubleshooting

**Release notes aren't appearing after a tag push**
The webhook now dispatches a GitHub Action instead of generating inline. Check:
1. **Vercel logs** — confirm the webhook fired and returned `{ action: "dispatched" }`
2. **GitHub Actions tab** — look for a "Generate GitHub Release Notes" or "Generate Release Notes" run triggered around the time of the tag push
3. If the Action doesn't appear, verify `LOUISA_GITHUB_REPO` and `GITHUB_TOKEN` are set in Vercel and the token has `repo` scope (needed to dispatch events to the Louisa repo)

**GitHub Action workflow doesn't appear in the UI**
`workflow_dispatch` workflows only appear in the Actions sidebar if the workflow file exists on the **default branch** (`main`). If you're testing on a feature branch, use the GitHub CLI: `gh workflow run generate-github-release.yml --ref your-branch --field tag=...`

**Webhook returns 401 (Invalid signature/token)**
The webhook secret in Vercel doesn't match the secret configured on the GitHub or GitLab webhook. Make sure they're identical.

**Notes appear but are empty or generic**
This usually means 0 commits were found between tags. Check that the previous release tag exists and that commits were made between the two tags.

**Duplicate releases**
Louisa checks for existing releases before creating one and skips if notes are already present. If you see duplicates, ensure the webhook isn't configured on multiple repos or that multiple webhook entries don't exist for the same URL.

**Slack notification not posting**
Verify `SLACK_WEBHOOK_URL` is set in Vercel and the Incoming Webhook is still active in your Slack app settings. Check Vercel logs for `Louisa: Slack post failed` messages.

**Teams notification not posting**
Verify `TEAMS_WEBHOOK_URL` is set in Vercel. If using classic Connectors, check that the connector hasn't expired or been removed from the channel. If using Workflows-based webhooks, verify the flow is enabled. Check Vercel logs for `Louisa: Teams post failed` messages.

**PR/MR descriptions aren't being enriched**
- Confirm the **Pull requests** event is checked on the GitHub webhook (Settings → Webhooks → Edit → individual events). GitLab requires **Merge request events** to be enabled.
- Confirm the GitHub token has **Pull requests: Read and write** permission (fine-grained PAT).
- Check Vercel function logs for `Louisa: enrich` messages — the enrichment step logs its outcome.
- If a PR was already enriched, the idempotency marker (`<!-- enriched-by-louisa -->`) prevents re-processing. Remove it from the description to force a re-run.

**No traces appearing in Arthur Engine**
- Verify `ARTHUR_BASE_URL` and `ARTHUR_API_KEY` are set in Vercel and match your Arthur instance
- Check Vercel logs for `Louisa: Arthur trace failed` or `Louisa: trace flush error` messages
- Arthur auto-creates a task named `louisa` on first trace receipt — look for it in the Arthur dashboard if you haven't set `ARTHUR_TASK_ID`

**GitHub Action fails with 403 on `git push` (summaries log)**
The Action commits the updated `logs/pr-summaries.jsonl` back to the repo. Ensure the workflow has `permissions: contents: write` (already set) and that branch protection rules don't block the `louisa-bot` committer.

---

## How It's Built

- **Runtime:** Node.js (ES modules) on Vercel Serverless Functions + GitHub Actions
- **AI:** Claude Haiku (`claude-haiku-4-5`) for per-PR summarization via tool use; Claude Opus (`claude-opus-4-6`) for final release note generation, via the [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) official SDK
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
