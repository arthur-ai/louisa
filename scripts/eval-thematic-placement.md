# Eval: Thematic Section Placement

Evaluates whether each bullet point in Louisa's generated release notes is placed in the most appropriate thematic section.

Louisa's prompt mandates grouping by product area (e.g. "Evaluation & Experiment Enhancements", "Trace Visibility & Debugging") rather than by change type ("New Features", "Bug Fixes"). This eval checks that each bullet's content genuinely belongs under the section heading it was placed in.

## Scoring (per bullet, then aggregated)

| Score | Meaning |
|-------|---------|
| 1.0 | Bullet unambiguously belongs under this section |
| 0.5 | Placement defensible but another section fits equally well |
| 0.0 | Bullet is clearly misplaced or section violates taxonomy |

**Overall score** = mean of per-bullet scores.

**Final binary**: score >= 0.5 → `1`, score < 0.5 → `0`

---

## Judge

**Model:** `claude-sonnet-4-6`
**Extended thinking:** enabled (`budget_tokens: 10000`)
**Max tokens:** 16000

### System prompt

You are an expert evaluator of AI-generated software release notes.

Your task is to assess whether each bullet point in a set of release notes has been placed under the most appropriate thematic section heading.

**Louisa's section taxonomy**

Louisa groups release notes by product area, not by change type. Valid section examples:

- "Evaluation & Experiment Enhancements"
- "Trace Visibility & Debugging"
- "Deployment & Infrastructure Enhancements"
- "User Experience Improvements"
- "Security & Access Control"
- "Integrations & Notifications"
- "Breaking Changes" (reserved for breaking changes only)

Invalid section patterns (change-type grouping, not product-area grouping):

- "New Features", "Bug Fixes", "Improvements", "Chores", "Fixes"

**Scoring each bullet**

For every bullet point, assign one of:

- `1.0` — The bullet unambiguously belongs under this section. Its topic, domain, and user impact all align with the section heading.
- `0.5` — Placement is defensible but another section would have been equally or more appropriate. The content straddles two product areas.
- `0.0` — The bullet is clearly misplaced. Its topic belongs in a different named section, or the section heading itself violates the taxonomy.

**Output format**

Respond ONLY with a JSON object — no markdown, no explanation outside the object:

```json
{
  "bullets": [
    {
      "section": "<exact section heading from the notes>",
      "bullet": "<first 80 chars of bullet text>",
      "score": 1.0,
      "reason": "<one sentence explaining the score>"
    }
  ],
  "overall": 0.95,
  "binary": 1,
  "section_issues": ["<any section heading that violates the product-area taxonomy>"],
  "misplaced": ["<brief description of any bullet that scored 0.0 and where it should go>"]
}
```

---

## Test cases

### `well-placed` — Well-structured release, all bullets in correct sections

**Commits:** streaming trace viewer, CSV export, token count fix, trace flush fix

**Expected:** PASS — single-domain changes map cleanly to correct sections

### `mixed-domains` — Multi-domain release (auth, evals, infra)

**Commits:** multi-model comparison, rubric builder, SAML SSO, RBAC, GitLab MR integration, Slack notifications, latency fix

**Expected:** PASS — each feature should land in its correct product-area section

### `single-pr` — Single-PR release, one feature

**Commits:** dark mode for evaluation dashboard

**Expected:** PASS — minimal release, single section, no misplacement possible

---

## Trace attributes emitted

| Attribute | Description |
|---|---|
| `eval.overall_score` | Float mean of per-bullet scores |
| `eval.binary_score` | Final `0` or `1` |
| `eval.bullet_count` | Total bullets evaluated |
| `eval.misplaced_count` | Bullets scoring `0.0` |
| `eval.section_issues_count` | Section headings violating taxonomy |

---

## Usage

```bash
set -a && source .env.local && set +a
node scripts/eval-thematic-placement.js
```
