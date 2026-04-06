# Eval: User-Facing Impact Classification

Evaluates whether each bullet point in Louisa's generated release notes describes a change that meaningfully impacts the end-user experience.

Louisa's release notes are aimed at external users, developers, and stakeholders. This eval checks that internal infrastructure, deployment, and operational changes (e.g. OIDC configuration, CI pipeline updates, dependency bumps) are not included — only changes that add value to or visibly affect the end-user experience should appear.

## Scoring (per bullet, then aggregated)

| Score | Meaning |
|-------|---------|
| 1.0 | Bullet describes a clear, direct end-user-facing change or benefit |
| 0.5 | Bullet describes a change with indirect or debatable user impact |
| 0.0 | Bullet describes an internal, infrastructure, or deployment-only change with no end-user impact |

**Overall score** = mean of per-bullet scores.

**Final binary**: score >= 0.5 → `1`, score < 0.5 → `0`

---

## Judge

**Model:** `claude-sonnet-4-6`
**Extended thinking:** enabled (`budget_tokens: 10000`)
**Max tokens:** 16000

### System prompt

You are an expert evaluator of AI-generated software release notes.

Your task is to assess whether each bullet point in a set of release notes describes a change that meaningfully impacts the end-user experience and belongs in external-facing release notes.

**What counts as user-facing**

A bullet is user-facing if it describes something an external user, developer, or stakeholder would directly notice, benefit from, or care about. Examples:

- New features, capabilities, or UI changes a user can interact with
- Bug fixes that correct visible or functional behaviour the user experienced
- Performance improvements a user would perceive (e.g. faster load times, lower latency)
- Security changes that affect how users authenticate or what they can access
- API or SDK changes that affect how developers integrate with the product

**What does NOT belong in external release notes**

A bullet should be excluded if it describes an internal or operational change that has no direct effect on the end-user experience. Examples:

- Deployment pipeline changes (e.g. OIDC configuration, CI/CD workflow updates)
- Infrastructure provisioning or cloud configuration changes
- Internal dependency version bumps with no user-visible effect
- Refactors or code quality improvements with no functional change
- Monitoring, alerting, or observability tooling changes
- Internal authentication mechanism changes (e.g. switching OIDC providers internally)

**Scoring each bullet**

For every bullet point, assign one of:

- `1.0` — The bullet clearly describes a user-facing change. An external user or developer would directly notice or benefit from it.
- `0.5` — The bullet describes a change with indirect or arguable user impact. It might matter to some users (e.g. a performance fix users could perceive) but is borderline.
- `0.0` — The bullet describes an internal, infrastructure, or deployment-only change. An external user would not notice or benefit from it and it should have been excluded.

Here is the content to evaluate:

{{output_messages}}

**Output format**

Respond ONLY with 0 or 1

---

## Variables

| Variable | Description |
|---|---|
| `{{output_messages}}` | The full generated release notes text from Louisa (`output.value` from the trace) |

---

## Test cases

### `clean-user-facing` — Release containing only genuine user-facing changes

**Commits:** dark mode toggle, multi-model comparison, CSV export for traces

**Expected:** PASS — all bullets describe features a user directly interacts with

### `mixed-with-infra` — Release containing user-facing changes alongside internal ones

**Commits:** streaming trace viewer, OIDC provider migration, CI runner update, token count fix

**Expected:** FAIL — OIDC and CI bullets should not appear; if they do, score drops below 0.5

### `infra-only` — Release containing only infrastructure and deployment changes

**Commits:** bump OTel exporter, update GitHub Actions runner, migrate OIDC configuration

**Expected:** FAIL — no bullet in this release belongs in external notes

---

## Trace attributes emitted

| Attribute | Description |
|---|---|
| `eval.overall_score` | Float mean of per-bullet scores |
| `eval.binary_score` | Final `0` or `1` |
| `eval.bullet_count` | Total bullets evaluated |
| `eval.excluded_count` | Bullets scoring `0.0` (should have been excluded) |
| `eval.borderline_count` | Bullets scoring `0.5` |

---

## Usage

```bash
set -a && source .env.local && set +a
node scripts/eval-user-facing-impact.js
```
