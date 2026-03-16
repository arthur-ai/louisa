# Louisa 🐶

**Automatic, AI-powered release notes for GitHub and GitLab — so your team never has to write them again.**

Louisa is a lightweight serverless bot that listens for new tags and releases on your GitHub or GitLab repos, analyzes the commits and pull/merge requests since the last release, and uses Claude to generate polished, user-facing release notes — published directly to your Releases page.

No manual steps. No copy-pasting changelogs. Just push a tag and Louisa handles the rest.

Works with **GitHub**, **GitLab**, or **both simultaneously**. Use whichever fits your workflow.

---

## How It Works

```
Tag pushed to GitHub or GitLab
        │
        ▼
Webhook fires ──► Vercel serverless function
        │
        ├─► Verifies webhook signature
        ├─► Fetches commits between this tag and the previous release
        ├─► Fetches merged pull requests (GitHub) or merge requests (GitLab)
        ├─► Calls Claude via the Anthropic SDK to generate release notes
        ├─► Creates a published Release with formatted notes
        ├─► Posts a summary to Slack (optional)
        │       └─► Logs release metadata to ./logs/ for monthly blog drafting
        └─► Sends full OpenInference traces to Arthur Engine (optional)
```

Louisa handles multiple scenarios:

- **Tag push (GitHub or GitLab)** — Automatically creates a published release with generated notes. No one needs to touch the Releases page manually.
- **Manual release (GitHub)** — If someone creates a release by hand, Louisa detects it and fills in the release notes if they're empty.

---

## What You Get

Louisa generates release notes that are:

- **Grouped by product area** — not by change type. Sections like "Evaluation & Experiment Enhancements" instead of "Bug Fixes" and "Features."
- **Written for users** — every bullet leads with the benefit or capability, not the code change.
- **Clean and consistent** — follows a structured format with section summaries, bold feature names, and horizontal dividers.
- **Free of internal noise** — CI changes, merge commits, and refactors are filtered out automatically.

---

## Platform Support

| Feature | GitHub | GitLab |
|---------|--------|--------|
| Tag push → auto-create release | ✅ | ✅ |
| Manual release → fill in notes | ✅ | — |
| Commit & PR/MR analysis | ✅ | ✅ |
| Slack notifications | ✅ | ✅ |
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
│   ├── github.js              # GitHub API client (commits, PRs, releases)
│   ├── gitlab.js              # GitLab API client (commits, MRs, releases)
│   ├── claude.js              # Anthropic SDK client for GitHub release notes
│   ├── claude-platform.js     # Anthropic SDK client for GitLab release notes
│   ├── slack.js               # Slack Incoming Webhook client + monthly release logger
│   └── crypto.js              # GitHub webhook signature verification
├── scripts/
│   ├── backfill-log.js        # Seed monthly log from existing GitHub/GitLab releases
│   └── draft-blog.js          # Generate monthly blog post from release logs
├── .github/
│   └── workflows/
│       └── draft-blog.yml     # Auto-drafts blog post on the 24th of each month
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
| `api/webhook.js` | Receives GitHub webhooks, routes tag and release events, orchestrates the GitHub pipeline |
| `api/gitlab-webhook.js` | Receives GitLab webhooks, handles tag push events, orchestrates the GitLab pipeline |
| `lib/otel.js` | Lazy-initialises the OpenTelemetry provider, patches the Anthropic SDK for auto-instrumentation, exports `getTracer`, `forceFlush`, and `activeSpan` |
| `lib/crypto.js` | Verifies GitHub webhook authenticity using HMAC-SHA256 with timing-safe comparison |
| `lib/github.js` | Compares tags, fetches commits, resolves merged PRs, creates and updates GitHub releases |
| `lib/gitlab.js` | Compares tags, fetches commits, resolves merged MRs, creates GitLab releases |
| `lib/claude.js` | Anthropic SDK client with the Claude prompt tailored for GitHub product release notes |
| `lib/claude-platform.js` | Anthropic SDK client with the Claude prompt tailored for GitLab product release notes |
| `lib/slack.js` | Posts release summaries to Slack; logs structured release metadata to `./logs/releases-{month}.json.lines` after each successful post |
| `scripts/backfill-log.js` | Fetches published release note bodies from GitHub and GitLab APIs and writes structured log entries — no Claude calls, safe to re-run, deduplicates by tag |
| `scripts/draft-blog.js` | Reads monthly release log entries and calls Claude to draft the Arthur "What's New" blog post in Ashley's voice |

### Tracing architecture

`lib/otel.js` initialises once per serverless container:

1. Creates a `NodeTracerProvider` with an `OTLPTraceExporter` pointed at `ARTHUR_BASE_URL/api/v1/traces`
2. Calls `AnthropicInstrumentation.manuallyInstrument(Anthropic)` to patch the SDK class — from this point, every `client.messages.create()` call automatically emits a fully-attributed `LLM` span following the OpenInference spec
3. Registers the provider as the global OTel tracer

The webhook handlers wrap each logical step in an `activeSpan()` call (CHAIN for the overall pipeline, TOOL for each API call). Because OTel context propagation uses `AsyncLocalStorage`, when `generateReleaseNotes()` calls `client.messages.create()` inside an active CHAIN span, the auto-instrumented LLM span is automatically nested as a child — no manual wiring required.

---

## Slack Notifications

When `SLACK_WEBHOOK_URL` is configured, Louisa automatically posts a summary to your Slack channel every time release notes are published — from either GitHub or GitLab. The Slack message includes:

- The product name (auto-detected from the release notes)
- The release tag name
- The theme summary from the release notes
- A list of key areas covered in the release
- A warning if the release includes breaking changes
- A **"View Full Release Notes"** button linking directly to the GitHub or GitLab release

Slack notifications are optional. If `SLACK_WEBHOOK_URL` is not set, Louisa skips the notification silently and everything else works as normal.

---

## Monthly Blog Post Drafting

Louisa doubles as a blog-drafting assistant. After each successful Slack notification, she logs structured metadata for that release — tag, product, theme, key areas, breaking changes, and the full generated notes — to a monthly newline-delimited JSON file at `./logs/releases-{month}.json.lines`.

On the 24th of each month, a GitHub Action reads the last 30 days of those log entries and calls Claude to draft Arthur's "What's New" monthly blog post in Ashley's voice. The draft lands in `output/blog-draft-{month}.md` and is uploaded as a GitHub Actions artifact, giving the team one week to review and polish before publishing.

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

**Required secrets:** `ANTHROPIC_API_KEY`, `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`
**Required repository variables:** `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`

You can also trigger it manually from the **Actions** tab with an optional month override (e.g. `"February 2026"`).

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
- **Notifications:** Slack Incoming Webhooks

---

## License

MIT

---

<p align="center">
  Built with ❤️ by <a href="https://www.ashleynader.com">Ashley Nader</a>
  <br>
  <em>README.md generated by Louisa 🐶</em>
</p>
