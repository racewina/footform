// Telegram Bot API client + message formatting for the FootForm bot.
//
// Plain fetch, no SDK. The bot token is read from env only and NEVER logged — it
// is embedded in every API URL, so failures log the METHOD name and Telegram's
// error code/description only, never the URL or a raw fetch error message.
//
// Saved "daily" queries are stored in a bot-authored PINNED message in the chat
// itself (header line + numbered queries). That gives free persistence with no
// store to provision, and the list is visible/manageable right in the chat.

const API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org"; // override = local test mock

export const telegramEnabled = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);

// Chats allowed to use the bot (comma-separated chat IDs). Empty = nobody.
export const allowedChatIds = () =>
  new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));

// Timezone the bot resolves "today"/"Saturday" in and prints kickoffs in. Defaults
// to the warm cron's first zone so bot scans reuse the warmed caches.
export const botTz = () =>
  process.env.TELEGRAM_TZ || (process.env.WARM_TZS || "America/Toronto").split(",")[0].trim();

// Local hours (in botTz) the daily list is pushed, e.g. "8" or "8,17".
export const pushHours = () =>
  (process.env.TELEGRAM_PUSH_HOURS || "8").split(",").map((s) => Number(s.trim())).filter((h) => h >= 0 && h <= 23);

export async function tg(method, payload = {}, timeoutMs = 10000) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) {
      console.error(`[telegram] ${method} failed: ${json?.error_code || res.status} ${json?.description || ""}`);
      return null;
    }
    return json.result;
  } catch (e) {
    console.error(`[telegram] ${method} error: ${e.name}`); // name only — message could carry the URL
    return null;
  } finally {
    clearTimeout(t);
  }
}

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sendText(chatId, text, { html = true, ...extra } = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    ...(html ? { parse_mode: "HTML" } : {}),
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export async function sendChunks(chatId, chunks) {
  for (const c of chunks) await sendText(chatId, c);
}

// Point the bot's webhook at this deployment (idempotent — safe to call hourly;
// re-setting also picks up a rotated TELEGRAM_WEBHOOK_SECRET) and publish the
// command menu. Host = TELEGRAM_WEBHOOK_HOST, else Vercel's production domain.
export async function ensureWebhook() {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const host = (process.env.TELEGRAM_WEBHOOK_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!telegramEnabled() || !secret || !host) return { ok: false, reason: "missing token, webhook secret, or host" };
  const url = `https://${host}/api/telegram/webhook`;
  const set = await tg("setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });
  await tg("setMyCommands", {
    commands: [
      { command: "help", description: "How to ask + examples" },
      { command: "daily", description: "Show / add / remove saved daily queries" },
      { command: "now", description: "Send the daily list right now" },
    ],
  });
  return { ok: Boolean(set), url };
}

// ---- Daily list, stored as a pinned message --------------------------------

export const MAX_DAILY = 5;
const DAILY_HEADER = "📌 FootForm daily picks";

// The pinned daily message, if the chat's most recent pin is ours.
export async function readDailyPin(chatId) {
  const chat = await tg("getChat", { chat_id: chatId });
  const pm = chat?.pinned_message;
  if (!pm?.text || !pm.from?.is_bot || !pm.text.startsWith(DAILY_HEADER)) return { messageId: null, queries: [] };
  const queries = pm.text.split("\n").slice(1)
    .map((l) => l.match(/^\d+\.\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
  return { messageId: pm.message_id, queries };
}

// Replace the list: post + pin the new one first (so it becomes the most recent
// pin), then unpin the old one. An empty list just unpins.
export async function writeDaily(chatId, queries, prevMessageId) {
  if (queries.length) {
    const hours = pushHours().map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
    const text = `${DAILY_HEADER} (sent ${hours} ${botTz()})\n${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;
    const sent = await sendText(chatId, text, { html: false }); // plain text: queries may contain < >
    if (!sent) return false;
    await tg("pinChatMessage", { chat_id: chatId, message_id: sent.message_id, disable_notification: true });
  }
  if (prevMessageId) await tg("unpinChatMessage", { chat_id: chatId, message_id: prevMessageId });
  return true;
}

// ---- Formatting an /ask result ----------------------------------------------

const SCOPE_LABEL = {
  "top-europe": "Top Europe", europe: "Europe", "south-america": "South America",
  "north-america": "North America", asia: "Asia", africa: "Africa", all: "All leagues",
};
const LIMIT = 3800; // headroom under Telegram's 4096-char message cap

// runAsk() result → one or more HTML message strings.
export function formatAsk(result, tz, { title = null, max = 25 } = {}) {
  const top = title ? `${title}\n` : "";
  if (result.note) return [`${top}${esc(result.note)}`];

  const p = result.params || {};
  const scope = p.scope === "league" ? p.leagueName : SCOPE_LABEL[p.scope] || p.scope;
  const filters = [`≥${p.minProb}%`];
  if (p.oddsMin != null && p.oddsMax != null) filters.push(`odds ${p.oddsMin}–${p.oddsMax}`);
  else if (p.oddsMin != null) filters.push(`odds ≥${p.oddsMin}`);
  else if (p.oddsMax != null) filters.push(`odds ≤${p.oddsMax}`);
  if (p.within && p.within !== "all") filters.push(`next ${p.within}h`);
  const head = `${top}⚽ <b>${esc((result.marketLabels || []).join(" + "))}</b>\n${esc(scope)} · ${esc(result.date)} · ${esc(filters.join(" · "))}`;

  if (!result.count) {
    const why = result.leaguesScanned === 0
      ? "no upcoming fixtures in that scope (try tomorrow or a weekday)."
      : "loosen the % or widen the scope/day.";
    return [`${head}\n\nNothing clears that bar — ${why}`];
  }

  const kfmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
  const shown = result.matches.slice(0, max);
  const lines = shown.map((m, i) => {
    const legs = Object.values(m.markets)
      .map((l) => `${esc(l.selection)} <b>${l.prob}%</b>${l.odds != null ? ` @${Number(l.odds).toFixed(2)}` : ""}`)
      .join(" · ");
    const ko = m.kickoff ? kfmt.format(new Date(m.kickoff * 1000)) : "";
    const live = m.status && m.status !== "notstarted" ? " · 🔴 live" : "";
    return `${i + 1}. ${legs}\n     ${esc(m.home)} v ${esc(m.away)} · ${m.leagueFlag || ""} ${esc(m.league)} · ${esc(ko)}${live}`;
  });

  const chunks = [];
  // "Top 5 of 12" when a count was asked for (or the 25-row cap cut the list).
  const tally = shown.length < result.count
    ? `<b>Top ${shown.length} of ${result.count} matches</b> (highest probability)`
    : `<b>${result.count} match${result.count === 1 ? "" : "es"}</b>`;
  let cur = `${head}\n${tally}\n`;
  for (const ln of lines) {
    if (cur.length + ln.length + 2 > LIMIT) { chunks.push(cur); cur = ln; }
    else cur += `\n${ln}`;
  }
  chunks.push(cur);
  return chunks;
}
