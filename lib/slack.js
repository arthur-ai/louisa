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
