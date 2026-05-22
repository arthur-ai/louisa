/**
 * Fetches the latest system prompt for a named prompt from Arthur Engine.
 *
 * Results are cached in-process so each serverless container only hits the
 * Arthur API once per prompt per cold start. Falls back to the provided
 * hardcoded string if Arthur is unreachable, not configured, or returns an
 * unexpected shape.
 *
 * Usage:
 *   import { fetchSystemPrompt } from "../lib/prompts.js";
 *   const system = await fetchSystemPrompt("release-notes-gitlab", FALLBACK);
 */

const _cache = new Map();

/**
 * @param {string} name     - prompt name registered in Arthur Engine
 * @param {string} fallback - hardcoded fallback system prompt
 * @returns {Promise<string>}
 */
export async function fetchSystemPrompt(name, fallback) {
  if (_cache.has(name)) return _cache.get(name);

  const baseUrl = process.env.ARTHUR_BASE_URL?.replace(/\/$/, "");
  const apiKey  = process.env.ARTHUR_API_KEY;
  const taskId  = process.env.ARTHUR_TASK_ID;

  if (!baseUrl || !apiKey || !taskId) return fallback;

  try {
    const res = await fetch(
      `${baseUrl}/api/v1/tasks/${taskId}/prompts/${encodeURIComponent(name)}/versions/latest`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) {
      console.warn(`Louisa: prompt "${name}" fetch failed (${res.status}), using fallback`);
      return fallback;
    }
    const data = await res.json();
    const system = data.messages?.find((m) => m.role === "system")?.content;
    if (!system) {
      console.warn(`Louisa: prompt "${name}" has no system message, using fallback`);
      return fallback;
    }
    _cache.set(name, system);
    console.log(`Louisa: loaded prompt "${name}" v${data.version} from Arthur Engine`);
    return system;
  } catch (err) {
    console.warn(`Louisa: error fetching prompt "${name}" —`, err.message, "— using fallback");
    return fallback;
  }
}
