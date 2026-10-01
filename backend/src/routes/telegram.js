// FootForm Telegram bot.
//
//   POST /api/telegram/webhook      Telegram → us. Messages + button taps. Typed
//                                   questions run through runAsk() (same engine as
//                                   the web chatbot); "menu"/"what can you do" and
//                                   every button go to the interactive layer in
//                                   telegramMenu.js; /daily + /now manage the list.
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
import {
  tg, telegramEnabled, allowedChatIds, botTz, pushHours, esc, sendText, keyboard,
  ensureWebhook, readDailyPin, writeDaily,
} from "../services/telegram.js";
import { isMenuIntent, showMenu, helpText, handleText, addDaily, runDaily, handleCallback } from "./telegramMenu.js";

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

const MENU_BTN = keyboard([[["📋 Menu", "m"]]]);

async function handleDaily(chatId, arg) {
  const a = arg.trim();
  if (a && !/^clear$/i.test(a) && !/^(?:remove|rm|delete|del)\s+\d+$/i.test(a)) {
    return sendText(chatId, await addDaily(chatId, a), { reply_markup: keyboard([[["🗓 My daily list", "dl"], ["📋 Menu", "m"]]]) });
  }
  const { messageId, queries } = await readDailyPin(chatId);
  const list = (qs) => (qs.length ? qs.map((q, i) => `${i + 1}. ${esc(q)}`).join("\n") : "<i>(none)</i>");
  if (!a) {
    return sendText(chatId, `🗓 <b>Daily searches</b>\n${list(queries)}\n\nManage them with buttons: 🗓 My daily list.`, { reply_markup: keyboard([[["🗓 My daily list", "dl"], ["📋 Menu", "m"]]]) });
  }
  if (/^clear$/i.test(a)) {
    await writeDaily(chatId, [], messageId);
    return sendText(chatId, "🧹 Daily list cleared.", { reply_markup: MENU_BTN });
  }
  const idx = Number(a.match(/(\d+)$/)[1]) - 1;
  if (idx < 0 || idx >= queries.length) return sendText(chatId, `No #${idx + 1} — you have ${queries.length} saved.`);
  const next = queries.filter((_, i) => i !== idx);
  await writeDaily(chatId, next, messageId);
  return sendText(chatId, `🗑 Removed #${idx + 1}.\n${list(next)}`, { reply_markup: MENU_BTN });
}

const isAllowed = (chatId) => allowedChatIds().has(String(chatId));

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  if (!isAllowed(chatId)) {
    // Setup aid: tell a private sender their chat ID; never run anything for them.
    if (msg.chat.type === "private") {
      await sendText(chatId, `🔒 This FootForm bot is private.\nYour chat ID is <code>${esc(chatId)}</code> — if this is you, add it to TELEGRAM_ALLOWED_CHAT_IDS in Vercel and redeploy.`);
    }
    return;
  }

  const text = msg.text.trim();
  const deadline = Date.now() + WORK_BUDGET_MS;
  const [first, ...rest] = text.split(/\s+/);
  const cmd = first.startsWith("/") ? first.slice(1).split("@")[0].toLowerCase() : null;
  const arg = rest.join(" ");

  if (cmd === "help") return sendText(chatId, helpText(), { reply_markup: MENU_BTN });
  if (cmd === "daily") return handleDaily(chatId, arg);
  if (cmd === "now") return runDaily(chatId, { deadline, manual: true });
  if (cmd === "start" || cmd === "menu" || isMenuIntent(text)) return showMenu(chatId);
  if (cmd) return sendText(chatId, "Unknown command.", { reply_markup: MENU_BTN });

  // Free text → rule parser when it can, Claude (if configured) for the rest.
  return handleText(chatId, text, msg);
}

async function handleButton(cq) {
  const chatId = cq.message?.chat?.id;
  if (chatId == null || !isAllowed(chatId)) {
    return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "This bot is private." });
  }
  return handleCallback(cq, { deadline: Date.now() + WORK_BUDGET_MS });
}

// Re-register the webhook once per instance on the first update after a deploy,
// so new subscriptions (button taps = callback_query) apply immediately instead
// of waiting for the hourly cron.
let webhookChecked = false;

router.post("/telegram/webhook", (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !telegramEnabled()) return res.status(503).json({ error: "telegram not configured" });
  if (!safeEqual(req.get("x-telegram-bot-api-secret-token"), secret)) return res.status(401).json({ error: "unauthorized" });

  const u = req.body || {};
  const fresh = !seenUpdate(u.update_id);
  const log = (e) => console.error(`[telegram] handler: ${e.message}`);
  if (fresh && u.message?.chat?.id != null && typeof u.message.text === "string") {
    waitUntil(handleMessage(u.message).catch(log));
  } else if (fresh && u.callback_query?.id) {
    waitUntil(handleButton(u.callback_query).catch(log));
  }
  if (!webhookChecked) { webhookChecked = true; waitUntil(ensureWebhook().catch(log)); }
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
    const sent = await runDaily(chatId, { deadline }).catch((e) => { console.error(`[telegram] push: ${e.message}`); return -1; });
    results.push({ chat: chatId.slice(-4), sent });
  }
  res.json({ webhook, pushed: results, ms: Date.now() - started });
});

export default router;
