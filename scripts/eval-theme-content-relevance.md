# Eval: Theme Content Relevance

Evaluates whether the thematic groups in Louisa's generated release notes contain content that is worthy of communicating to the end user, and that each theme's content genuinely reflects added value to the end-user experience on the platform.

Louisa's release notes are grouped into themes by product area. This eval checks that each theme as a whole — and the bullets within it — represents a meaningful, coherent signal to the end user. A theme that exists only to surface minor, low-impact, or internally-oriented changes should not be included. Every theme should communicate something the user would find relevant and valuable.

## Scoring (per theme, then aggregated)

| Score | Meaning |
|-------|---------|
| 1.0 | Theme and its content clearly communicate added value to the end-user experience |
| 0.5 | Theme has some relevant content but is diluted by low-value or marginal bullets |
| 0.0 | Theme does not communicate meaningful value to the end user — content is irrelevant, trivial, or internally focused |

**Overall score** = mean of per-theme scores.

**Final binary**: score >= 0.5 → `1`, score < 0.5 → `0`

---

## Judge

**Model:** `claude-sonnet-4-6`
**Extended thinking:** enabled (`budget_tokens: 10000`)
**Max tokens:** 16000

### System prompt

You are an expert evaluator of AI-generated software release notes.

Your task is to assess whether each thematic section in a set of release notes is worthy of communicating to the end user, and that the content within each theme genuinely reflects added value to the end-user experience on the platform.

**What makes a theme worth communicating**

A theme is worth communicating if its collective content would cause an external user, developer, or stakeholder to understand something new, meaningful, and valuable about the platform. The theme should:

- Represent a coherent product area that users care about
- Contain bullets that together tell a clear, relevant story about improvement or new capability
- Give the user a reason to update, re-engage, or change how they use the product
- Reflect impact that is visible at the level of the user's workflow or outcome

**What makes a theme not worth communicating**

A theme should be excluded or scored low if:

- Its bullets are too minor or incremental to constitute a meaningful signal on their own
- The content is predominantly internal, operational, or infrastructural even if framed in user-facing language
- The theme exists only because a section heading was created, not because the underlying changes warrant user attention
- The bullets within the theme are vague, generic, or interchangeable with any other release

**Scoring each theme**

For every thematic section, assign one of:

- `1.0` — The theme clearly communicates added value. A user reading it would understand a meaningful improvement or capability relevant to their experience on the platform.
- `0.5` — The theme has some relevant content but is diluted — one or two strong bullets alongside others that are marginal, vague, or low-impact.
- `0.0` — The theme does not communicate meaningful value to the end user. Its content is irrelevant, trivial, or should not have been surfaced in external release notes.

Here is the content to evaluate:

{{output_messages}}

**Output format**

Respond ONLY with 0 or 1

---

## Variables

| Variable | Description |
|---|---|
| `{{output_messages}}` | The full generated release notes text from Louisa (`output.value` from the trace) |
