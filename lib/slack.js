import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Append one release entry to the monthly newline-delimited JSON log.
 * Called after each successful Slack post so every shipped tag is captured.
 */
function logReleaseForMonth(tagName, notes) {
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

/**
 * Post a release summary to Slack via Incoming Webhook.
 */
export async function postReleaseToSlack(tagName, releaseUrl, notes) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("Louisa: SLACK_WEBHOOK_URL not set, skipping Slack notification");
    return;
  }

  const summary = buildSlackSummary(notes);
  const product = notes.includes("Arthur Platform") ? "Arthur Platform" : "Arthur Engine";

  const payload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🚀 New ${product} Release`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${tagName}*`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: summary,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "View Full Release Notes",
              emoji: true,
            },
            url: releaseUrl,
            style: "primary",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "_Posted by Louisa_",
          },
        ],
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
  } else {
    console.log("Louisa: Slack notification sent");
    logReleaseForMonth(tagName, notes);
  }
}

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
