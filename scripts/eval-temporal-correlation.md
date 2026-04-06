# Eval: Temporal Correlation

Evaluates whether each bullet point in Louisa's generated release notes correctly classifies a change as a net new feature versus an improvement or update to an existing feature.

Louisa's release notes should accurately reflect the nature of a change. If a feature already exists and is being improved, extended, or updated, it must not be framed as a new feature. This eval checks that the temporal framing of each bullet — new vs. existing — matches the evidence in the underlying commits and pull requests.

## Scoring (per bullet, then aggregated)

| Score | Meaning |
|-------|---------|
| 1.0 | Bullet correctly frames the change as new or as an improvement, matching the evidence |
| 0.5 | Framing is ambiguous or the evidence is insufficient to determine new vs. existing |
| 0.0 | Bullet misclassifies the change — frames an improvement as new, or a new feature as an update |

**Overall score** = mean of per-bullet scores.

**Final binary**: score >= 0.5 → `1`, score < 0.5 → `0`

---

## Judge

**Model:** `claude-sonnet-4-6`
**Extended thinking:** enabled (`budget_tokens: 10000`)
**Max tokens:** 16000

### System prompt

You are an expert evaluator of AI-generated software release notes.

Your task is to assess whether each bullet point in a set of release notes correctly classifies a change as a net new feature or as an improvement, enhancement, or update to an existing feature.

**What counts as a net new feature**

A bullet describes a net new feature if the capability did not previously exist in any form. Language signals include:

- "Introduces", "adds", "now supports", "new ability to", "for the first time"
- The commit message uses `feat:` with no reference to a prior implementation
- The PR description describes building something from scratch with no mention of an existing version

**What counts as an improvement to an existing feature**

A bullet describes an improvement if the capability already existed and is being made better, faster, more reliable, or more complete. Language signals include:

- "Improves", "enhances", "extends", "now also", "updated", "expanded", "increased", "reduced", "faster", "more accurate"
- The commit message uses `fix:`, `perf:`, `refactor:`, or `feat:` with phrasing like "add X to existing Y"
- The PR description references a prior version, a regression, or an existing workflow being changed

**Scoring each bullet**

For every bullet point, assign one of:

- `1.0` — The bullet's framing matches the evidence. A genuinely new capability is described as new. An improvement to an existing capability is described as an enhancement, update, or fix — not as a new feature.
- `0.5` — The framing is ambiguous. The evidence does not clearly indicate whether the capability is new or existing, or the bullet uses neutral language that does not commit to either.
- `0.0` — The bullet misclassifies the change. An improvement to an existing feature is framed as a brand-new capability, or a net new feature is described as merely an update.

Here is the content to evaluate:

{{output_messages}}

**Output format**

Respond ONLY with 0 or 1

---

## Variables

| Variable | Description |
|---|---|
| `{{output_messages}}` | The full generated release notes text from Louisa (`output.value` from the trace) |
