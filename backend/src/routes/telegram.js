// FootForm Telegram bot.
//
//   POST /api/telegram/webhook      Telegram → us. Any text is run through runAsk()
//                                   (the same engine as the web chatbot); /daily
//                                   manages saved queries; /now sends them.
//   GET  /api/cron/telegram-push    Hourly Vercel cron. At TELEGRAM_PUSH_HOURS
//                                   (local, botTz) it sends each allowed chat its
//                                   saved daily queries. Also (re)registers the
//                                   webhook every run, so a fresh deploy self-wires.
//
// Locked down: the webhook must carry TELEGRAM_WEBHOOK_SECRET (Telegram echoes it
// in a header), only TELEGRAM_ALLOWED_CHAT_IDS get answers, and the push cron
// refuses to run without CRON_SECRET (else anyone could spam you + burn API quota).
//
// Telegram expects a fast webhook reply but a cold multi-day scan can take
// minutes, so the webhook acks immediately and does the work in waitUntil()
// (runs on inside the function's 300s budget).

import express from "express";
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { runAsk } from "./fixtures.js";
import { parseQuery } from "../services/chatbot.js";
import { LEAGUES } from "../data/leagues.js";
import {
  tg, telegramEnabled, allowedChatIds, botTz, pushHours, esc, sendText, sendChunks,
  ensureWebhook, readDailyPin, writeDaily, formatAsk, MAX_DAILY,
} from "../services/telegram.js";

const router = express.Router();
const WORK_BUDGET_MS = 240 * 1000; // leave headroom under the 300s maxDuration

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Telegram retries a webhook it thinks failed; drop repeats (best-effort, per instance).
const seen = new Set();
const seenUpdate = (id) => {
  if (id == null) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  return false;
};

const helpText = () => {
  const hours = pushHours().map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
  return [
    "⚽ <b>FootForm</b> — ask in plain English and I'll run the prediction model:",
    "• <i>europe friday and saturday team to score 2+ odds over 1.46</i>",
    "• <i>top europe over 2.5 and btts this weekend above 60%</i>",
    "• <i>premier league double chance tomorrow</i>",
    "• <i>5 games over 2.5 tomorrow</i> — a number gives you the top N by probability",
    "",
    "Markets: over/under 1.5·2.5·3.5, BTTS, to win, double chance, team to score / 2+.",
    "Scope: top Europe, a continent, or a league name. Days: today, tomorrow, weekend, weekday names.",
    "",
    `<b>Daily push</b> — sent at ${esc(hours)} (${esc(botTz())}):`,
    "/daily <i>query</i> — save a query",
    "/daily — show saved queries",
    "/daily remove 2 — delete #2 · /daily clear — delete all",
    "/now — send the daily list right now",
  ].join("\n");
};

// Run each saved query and send the results. Stops starting new ones past the deadline.
async function runDaily(chatId, tz, { deadline, manual = false } = {}) {
  const { queries } = await readDailyPin(chatId);
  if (!queries.length) {
    if (manual) await sendText(chatId, "No daily queries saved yet. Add one with /daily <i>query</i>.");
    return 0;
  }
  let sent = 0;
  for (const [i, q] of queries.entries()) {
    if (Date.now() > deadline) {
      await sendText(chatId, `⏱ Ran out of time before “${esc(q)}” — send /now to retry.`);
      break;
    }
    try {
      const r = await runAsk(q, tz);
      await sendChunks(chatId, formatAsk(r, tz, { title: `🗓 <b>Daily ${i + 1}:</b> <i>${esc(q)}</i>` }));
      sent++;
    } catch (e) {
      await sendText(chatId, `⚠️ “${esc(q)}” failed: ${esc(e.message)}`);
    }
  }
  return sent;
}

async function handleDaily(chatId, arg) {
  const { messageId, queries } = await readDailyPin(chatId);
  const a = arg.trim();
  const list = (qs) => (qs.length ? qs.map((q, i) => `${i + 1}. ${esc(q)}`).join("\n") : "<i>(none)</i>");

  if (!a) {
    return sendText(chatId, `🗓 <b>Daily queries</b>\n${list(queries)}\n\nAdd: /daily <i>query</i> · Remove: /daily remove 2 · /daily clear`);
  }
  if (/^clear$/i.test(a)) {
    await writeDaily(chatId, [], messageId);
    return sendText(chatId, "🗑 Daily list cleared.");
  }
  const rm = a.match(/^(?:remove|rm|delete|del)\s+(\d+)$/i);
  if (rm) {
    const idx = Number(rm[1]) - 1;
    if (idx < 0 || idx >= queries.length) return sendText(chatId, `No #${rm[1]} — you have ${queries.length} saved.`);
    const next = queries.filter((_, i) => i !== idx);
    await writeDaily(chatId, next, messageId);
    return sendText(chatId, `Removed #${rm[1]}.\n${list(next)}`);
  }
  // Add — only if the parser can find a market in it, so the push never sends a dud.
  if (!parseQuery(a, LEAGUES).markets.length) {
    return sendText(chatId, "I couldn't spot a market in that, so I didn't save it. Try e.g. <i>top europe over 2.5 tomorrow</i>.");
  }
  if (queries.length >= MAX_DAILY) return sendText(chatId, `You already have ${MAX_DAILY} (the max). Remove one first: /daily remove N`);
  const next = [...queries, a.replace(/\s+/g, " ").slice(0, 200)];
  const ok = await writeDaily(chatId, next, messageId);
  return sendText(chatId, ok ? `✅ Saved. It'll be pinned above and sent daily.\n${list(next)}` : "⚠️ Couldn't save that — try again.");
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  if (!allowedChatIds().has(chatId)) {
    // Setup aid: tell a private sender their chat ID; never run anything for them.
    if (msg.chat.type === "private") {
      await sendText(chatId, `🔒 This FootForm bot is private.\nYour chat ID is <code>${esc(chatId)}</code> — if this is you, add it to TELEGRAM_ALLOWED_CHAT_IDS in Vercel and redeploy.`);
    }
    return;
  }

  const text = msg.text.trim();
  const tz = botTz();
  const deadline = Date.now() + WORK_BUDGET_MS;
  const [first, ...rest] = text.split(/\s+/);
  const cmd = first.startsWith("/") ? first.slice(1).split("@")[0].toLowerCase() : null;
  const arg = rest.join(" ");

  if (cmd === "start" || cmd === "help") return sendText(chatId, helpText());
  if (cmd === "daily") return handleDaily(chatId, arg);
  if (cmd === "now") return runDaily(chatId, tz, { deadline, manual: true });
  if (cmd) return sendText(chatId, "Unknown command — /help");

  // Free text → the model. Post a placeholder, then edit it into the first page.
  const ack = await sendText(chatId, "⏳ Running the model across the fixtures…");
  let chunks;
  try {
    chunks = formatAsk(await runAsk(text, tz), tz);
  } catch (e) {
    chunks = [`⚠️ Something went wrong: ${esc(e.message)}`];
  }
  const [head, ...tail] = chunks;
  const edited = ack && await tg("editMessageText", {
    chat_id: chatId, message_id: ack.message_id, text: head, parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  if (!edited) await sendText(chatId, head);
  await sendChunks(chatId, tail);
}

router.post("/telegram/webhook", (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !telegramEnabled()) return res.status(503).json({ error: "telegram not configured" });
  if (!safeEqual(req.get("x-telegram-bot-api-secret-token"), secret)) return res.status(401).json({ error: "unauthorized" });

  const msg = req.body?.message;
  if (msg?.chat?.id != null && typeof msg.text === "string" && !seenUpdate(req.body.update_id)) {
    waitUntil(handleMessage(msg).catch((e) => console.error(`[telegram] handler: ${e.message}`)));
  }
  res.status(200).json({ ok: true }); // ack now; the work continues in waitUntil
});

router.get("/cron/telegram-push", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(503).json({ error: "Set CRON_SECRET to enable scheduled Telegram pushes." });
  if (!safeEqual(req.headers.authorization, `Bearer ${cronSecret}`)) return res.status(401).json({ error: "unauthorized" });
  if (!telegramEnabled()) return res.json({ skipped: "TELEGRAM_BOT_TOKEN not set" });

  const started = Date.now();
  const webhook = await ensureWebhook();
  const tz = botTz();
  const hourNow = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const force = req.query.force === "1";
  if (!force && !pushHours().includes(hourNow)) {
    return res.json({ webhook, skipped: `not a push hour (${hourNow}:00 ${tz}; pushes at ${pushHours().join(",")})` });
  }

  const deadline = started + WORK_BUDGET_MS;
  const results = [];
  for (const chatId of allowedChatIds()) {
    const sent = await runDaily(chatId, tz, { deadline }).catch((e) => { console.error(`[telegram] push: ${e.message}`); return -1; });
    results.push({ chat: chatId.slice(-4), sent });
  }
  res.json({ webhook, pushed: results, ms: Date.now() - started });
});

export default router;
