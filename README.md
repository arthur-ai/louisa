# Louisa 🤖

**Automatic, AI-powered release notes for GitHub — so your team never has to write them again.**

Louisa is a lightweight serverless bot that listens for new tags and releases on your GitHub repo, analyzes the commits and pull requests since the last release, and uses Claude to generate polished, user-facing release notes — published directly to your GitHub Releases page.

No manual steps. No copy-pasting changelogs. Just push a tag and Louisa handles the rest.

---

## How It Works

```
Tag pushed to GitHub
        │
        ▼
GitHub webhook fires ──► Vercel serverless function
        │
        ├─► Verifies webhook signature (HMAC-SHA256)
        ├─► Fetches commits between this tag and the previous release
        ├─► Fetches merged pull requests for those commits
        ├─► Sends everything to Claude for analysis and summarization
        └─► Creates a published GitHub Release with formatted notes
```

Louisa handles two scenarios:

1. **Tag push** — When a new tag is pushed, Louisa automatically creates a published release with generated notes. No one needs to touch GitHub Releases manually.
2. **Manual release** — If someone creates a release by hand, Louisa detects it and fills in the release notes if they're empty.

---

## What You Get

Louisa generates release notes that are:

- **Grouped by product area** — not by change type. Sections like "Evaluation & Experiment Enhancements" instead of "Bug Fixes" and "Features."
- **Written for users** — every bullet leads with the benefit or capability, not the code change.
- **Clean and consistent** — follows a structured format with section summaries, bold feature names, and horizontal dividers.
- **Free of internal noise** — CI changes, merge commits, and refactors are filtered out automatically.

---

## Prerequisites

- A [GitHub](https://github.com) repository you want to generate release notes for
- A [Vercel](https://vercel.com) account (free tier works)
- An [Anthropic](https://console.anthropic.com) API key (for Claude)
- A GitHub Personal Access Token with read/write access to your repo's contents and releases
- Admin access to the repo (to configure the webhook)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/louisa.git
cd louisa
npm install
```

### 2. Configure environment variables

Create a `.env.local` file in the project root:

```env
GITHUB_TOKEN=ghp_your_github_token
GITHUB_WEBHOOK_SECRET=your_webhook_secret
ANTHROPIC_API_KEY=sk-ant-your_anthropic_key
GITHUB_REPO_OWNER=your-org
GITHUB_REPO_NAME=your-repo
```

To generate a webhook secret:

```bash
openssl rand -hex 32
```

**GitHub Token permissions** (fine-grained token):
- **Contents** — Read and write
- Scoped to the repo you want release notes for

**Anthropic API Key:**
- Create one at [console.anthropic.com](https://console.anthropic.com)

### 3. Deploy to Vercel

```bash
vercel link
vercel --prod
```

Then add the same environment variables in the Vercel dashboard under **Project → Settings → Environment Variables**.

### 4. Configure the GitHub webhook

On the repo you want Louisa to monitor (not the Louisa repo itself):

1. Go to **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://your-vercel-domain.vercel.app/api/webhook`
3. **Content type:** `application/json`
4. **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
5. **Events:** Select "Let me select individual events" and check:
   - **Branch or tag creation** (triggers release creation on tag push)
   - **Releases** (triggers note generation on manual releases)
6. Click **Add webhook**

---

## Project Structure

```
louisa/
├── api/
│   └── webhook.js       # Vercel serverless function — main entry point
├── lib/
│   ├── github.js         # GitHub API client (commits, PRs, releases)
│   ├── claude.js          # Anthropic API client (note generation)
│   └── crypto.js          # Webhook signature verification
├── package.json
├── vercel.json
└── .env.local             # Local environment variables (not committed)
```

---

## Architecture

Louisa is intentionally simple — no frameworks, no SDKs, no database. Everything runs in a single Vercel serverless function using native `fetch` calls to the GitHub and Anthropic APIs.

| Component | Purpose |
|-----------|---------|
| `api/webhook.js` | Receives GitHub webhooks, routes between tag and release events, orchestrates the pipeline |
| `lib/crypto.js` | Verifies webhook authenticity using HMAC-SHA256 with timing-safe comparison |
| `lib/github.js` | Compares tags, fetches commits, resolves merged PRs, creates and updates releases |
| `lib/claude.js` | Builds the prompt and calls Claude to transform raw data into formatted release notes |

---

## Customizing the Release Notes Format

The release notes style is controlled by the system prompt in `lib/claude.js`. You can customize:

- **Grouping** — Change how changes are categorized (by product area, by change type, etc.)
- **Tone** — Adjust from marketing-forward to technical, conversational, or minimal
- **Structure** — Modify the heading format, section dividers, summary paragraphs, etc.
- **Filtering** — Control which types of changes are included or excluded

Edit the `systemPrompt` string in `lib/claude.js` and redeploy.

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

**Webhook returns 401 (Invalid signature)**
The `GITHUB_WEBHOOK_SECRET` in Vercel doesn't match the secret configured on the GitHub webhook. Make sure they're identical.

**Release notes aren't appearing**
Check the Vercel function logs at **vercel.com → Project → Deployments → Latest → Functions**. Common causes:
- GitHub token doesn't have write access to the target repo
- Environment variables aren't set in Vercel (or weren't redeployed after adding them)
- The webhook isn't firing the right events (check Recent Deliveries on the webhook page)

**Notes appear but are empty or generic**
This usually means 0 commits were found between tags. Check that the previous release tag exists and that commits were made between the two tags.

**Duplicate releases**
Louisa checks for existing releases before creating one and skips if notes are already present. If you see duplicates, ensure the webhook isn't configured on multiple repos or that multiple webhook entries don't exist for the same URL.

---

## How It's Built

- **Runtime:** Node.js (ES modules) on Vercel Serverless Functions
- **AI:** Claude Sonnet via the Anthropic Messages API
- **APIs:** GitHub REST API v3 (direct fetch, no SDK)
- **Auth:** HMAC-SHA256 webhook verification, Bearer token for GitHub
- **Dependencies:** None beyond Node built-ins

---

## License

MIT

---

<p align="center">
  Built with ❤️ by <a href="https://ashleynader.com/arthur-ai">Ashley Nader</a>
  <br>
  <em>Release notes generated by Louisa 🤖</em>
</p>