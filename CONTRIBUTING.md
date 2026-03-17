# Contributing to Louisa

Contributions are welcome — bug fixes, new platform integrations, notification channels, prompt improvements, and documentation all count. Here's how to get started.

---

## Getting started

1. Fork the repo and clone it locally
2. Run `npm install`
3. Copy the env var block from the [README setup section](README.md#2-configure-environment-variables) into a new `.env.local` file and fill in your credentials
4. Create a branch: `git checkout -b your-feature-name`
5. Make your changes, test locally, then open a pull request

---

## Local development

**Run the webhook server locally:**
```bash
npm run dev   # starts vercel dev on http://localhost:3000
```

Use a tool like [ngrok](https://ngrok.com) or [smee.io](https://smee.io) to forward GitHub or GitLab webhook events to your local server for end-to-end testing.

**Test the monthly pipeline scripts directly:**
```bash
set -a && source .env.local && set +a

# Seed the release log
node scripts/backfill-log.js <github-owner> <github-repo> --days 30

# Draft a blog post
node scripts/draft-blog.js "March 2026" --days 30

# Publish a changelog entry
node scripts/publish-changelog.js "March 2026"
```

---

## Project structure

```
api/          Vercel serverless webhook handlers (GitHub + GitLab)
lib/          Shared modules: API clients, Claude prompts, notifications, tracing
scripts/      CLI scripts for the optional monthly content pipelines
.github/      GitHub Actions workflows for the monthly pipelines
```

---

## Code style

- ES modules (`import`/`export`) throughout — no CommonJS
- Native `fetch` and `node:crypto` — avoid adding new runtime dependencies
- Keep functions focused and named for what they do
- Console output uses the `Louisa:` prefix for log lines

---

## What makes a good contribution

- **New notification channel** — mirror the Slack/Teams pattern in `lib/slack.js`
- **New platform** — follow the `lib/github.js` + `api/webhook.js` pattern for a new VCS
- **Prompt improvements** — edit `lib/claude.js` (GitHub) or `lib/claude-platform.js` (GitLab)
- **Bug fixes** — include a description of how to reproduce the issue in the PR
- **Documentation** — README fixes and clarifications are always welcome

---

## Submitting a pull request

- One logical change per PR
- Write a clear PR description explaining the *why*, not just the *what*
- If your change affects behavior, describe how you tested it

---

## Questions?

Open a [Discussion](https://github.com/arthur-ai/louisa/discussions) or file an [Issue](https://github.com/arthur-ai/louisa/issues).
