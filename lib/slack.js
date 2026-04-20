import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Append one release entry to the monthly newline-delimited JSON log.
 * Called after each notification dispatch so every shipped tag is captured.
 */
function logReleaseForMonth(tagName, notes) {
  // Vercel's filesystem is read-only — logs are only written from GitHub Actions
  // where the updated file gets committed back to the repo.
  if (process.env.VERCEL) return;

  try {
    const now = new Date();
    const monthName = now.toLocaleString("en-US", { month: "long" }).toLowerCase();
    const year = now.getFullYear();
    const monthSlug = `${monthName}-${year}`;

    const logsDir = join(process.cwd(), "logs");
    mkdirSync(logsDir, { recursive: true });

    const product = notes.includes("Arthur Platform") ? "Arthur Platform" : "Arthur Engine";
    const { theme, keyAreas, breakingChanges } = extractReleaseMetadata(notes);

    const entry = {
      product,
      tag: tagName,
      theme,
      keyAreas,
      breakingChanges,
      summary: notes,
      timestamp: now.toISOString(),
    };

    const logPath = join(logsDir, `releases-${monthSlug}.json.lines`);
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
    console.log(`Louisa: release logged to ${logPath}`);
  } catch (err) {
    console.error("Louisa: failed to log release for month", err);
  }
}

/**
 * Extract structured metadata from Claude-generated release notes markdown.
 */
function extractReleaseMetadata(notes) {
  const lines = notes.split("\n");

  // Theme: first non-empty, non-header, non-separator line after the **Date** line
  let theme = "";
  let foundDate = false;
  for (const line of lines) {
    if (!foundDate && line.startsWith("**")) {
      foundDate = true;
      continue;
    }
    if (foundDate && line.trim() && !line.startsWith("#") && !line.startsWith("---")) {
      theme = line.trim();
      break;
    }
  }

  // Key areas: ## section titles, excluding breaking changes
  const keyAreas = lines
    .filter((l) => l.startsWith("## ") && !l.toLowerCase().includes("breaking"))
    .map((l) => l.replace("## ", "").trim());

  // Breaking changes: null if none
  const hasBreaking = lines.some((l) => l.toLowerCase().includes("breaking changes"));
  const breakingChanges = hasBreaking ? "Yes" : null;

  return { theme, keyAreas, breakingChanges };
}

// ── Slack ──────────────────────────────────────────────────────────────────────

function buildSlackSummary(notes) {
  const lines = notes.split("\n");
  const parts = [];

  let foundDate = false;
  for (const line of lines) {
    if (line.startsWith("**") && !foundDate) {
      foundDate = true;
      continue;
    }
    if (foundDate && line.trim() && !line.startsWith("#") && !line.startsWith("---")) {
      parts.push(line.trim());
      break;
    }
  }

  const sections = lines
    .filter((l) => l.startsWith("## ") && !l.includes("Breaking Changes"))
    .map((l) => l.replace("## ", "").trim());

  const hasBreaking = lines.some((l) => l.includes("Breaking Changes"));

  if (hasBreaking) {
    parts.push("\n⚠️ *This release includes breaking changes.*");
  }

  if (sections.length > 0) {
    parts.push("\n*Key areas:*");
    for (const section of sections) {
      parts.push(`• ${section}`);
    }
  }

  return parts.join("\n");
}

async function _postToSlack(tagName, releaseUrl, notes) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const summary = buildSlackSummary(notes);
  const product = notes.includes("Arthur Platform") ? "Arthur Platform" : "Arthur Engine";

  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🚀 New ${product} Release`, emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${tagName}*` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: summary },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Full Release Notes", emoji: true },
            url: releaseUrl,
            style: "primary",
          },
        ],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "_Posted by Louisa_" }],
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Louisa: Slack post failed ${res.status} — ${err}`);
    return false;
  }

  console.log("Louisa: Slack notification sent");
  return true;
}

// ── Teams ──────────────────────────────────────────────────────────────────────

async function _postToTeams(tagName, releaseUrl, notes) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const lines = notes.split("\n");
  const product = notes.includes("Arthur Platform") ? "Arthur Platform" : "Arthur Engine";

  // Extract theme (first non-header line after the **date** line)
  let theme = "";
  let foundDate = false;
  for (const line of lines) {
    if (line.startsWith("**") && !foundDate) { foundDate = true; continue; }
    if (foundDate && line.trim() && !line.startsWith("#") && !line.startsWith("---")) {
      theme = line.trim();
      break;
    }
  }

  const sections = lines
    .filter((l) => l.startsWith("## ") && !l.includes("Breaking Changes"))
    .map((l) => l.replace("## ", "").trim());

  const hasBreaking = lines.some((l) => l.includes("Breaking Changes"));

  // Build Adaptive Card body
  const body = [
    { type: "TextBlock", text: `🚀 New ${product} Release`, weight: "Bolder", size: "Large" },
    { type: "TextBlock", text: tagName, weight: "Bolder" },
  ];

  if (theme) {
    body.push({ type: "TextBlock", text: theme, wrap: true });
  }

  if (hasBreaking) {
    body.push({
      type: "TextBlock",
      text: "⚠️ This release includes breaking changes.",
      color: "Warning",
      wrap: true,
    });
  }

  if (sections.length > 0) {
    body.push({ type: "TextBlock", text: "Key areas:", weight: "Bolder" });
    body.push({ type: "TextBlock", text: sections.map((s) => `• ${s}`).join("\n"), wrap: true });
  }

  const payload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body,
          actions: [
            { type: "Action.OpenUrl", title: "View Full Release Notes", url: releaseUrl },
          ],
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Louisa: Teams post failed ${res.status} — ${err}`);
    return false;
  }

  console.log("Louisa: Teams notification sent");
  return true;
}

// ── Dispatchers ────────────────────────────────────────────────────────────────

/**
 * Post a release notification to all configured channels (Slack, Teams, or both).
 * Set SLACK_WEBHOOK_URL and/or TEAMS_WEBHOOK_URL to enable each channel independently.
 * Logs release metadata for the monthly pipeline if at least one notification succeeds.
 */
export async function postReleaseNotification(tagName, releaseUrl, notes) {
  const hasSlack = !!process.env.SLACK_WEBHOOK_URL;
  const hasTeams = !!process.env.TEAMS_WEBHOOK_URL;

  if (!hasSlack && !hasTeams) {
    console.warn("Louisa: neither SLACK_WEBHOOK_URL nor TEAMS_WEBHOOK_URL is set, skipping notifications");
    return;
  }

  const results = await Promise.allSettled([
    hasSlack ? _postToSlack(tagName, releaseUrl, notes)  : Promise.resolve(false),
    hasTeams ? _postToTeams(tagName, releaseUrl, notes) : Promise.resolve(false),
  ]);

  const anySent = results.some((r) => r.status === "fulfilled" && r.value === true);
  if (anySent) logReleaseForMonth(tagName, notes);
}

/**
 * Post a release summary to Slack via Incoming Webhook.
 * @deprecated Use postReleaseNotification for combined Slack + Teams support.
 */
export async function postReleaseToSlack(tagName, releaseUrl, notes) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("Louisa: SLACK_WEBHOOK_URL not set, skipping Slack notification");
    return;
  }

  const sent = await _postToSlack(tagName, releaseUrl, notes);
  if (sent) logReleaseForMonth(tagName, notes);
}
