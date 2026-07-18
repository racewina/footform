import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fixturesRouter from "./routes/fixtures.js";
import seoRouter from "./routes/seo.js";
import { cacheStats } from "./services/cache.js";

const app = express();

// Behind Vercel's edge/proxy in production; required so express-rate-limit can
// read the real client IP from X-Forwarded-For without throwing.
app.set("trust proxy", 1);

app.use(
  cors({
    // Same-origin in production (frontend + API share the Vercel domain);
    // FRONTEND_URL lets a separate dev origin connect. `true` reflects origin.
    origin: process.env.FRONTEND_URL || true,
    methods: ["GET"],
  })
);

app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, slow down" },
});
app.use("/api", limiter);

// Edge-cache read-only API responses on Vercel's CDN. The heavy cross-league
// aggregations (e.g. /today across 26 leagues) take ~20s to build on a cold
// cache; caching the RESPONSE at the edge means that cost is paid once and
// shared by everyone, and stale-while-revalidate serves the cached copy
// instantly while a fresh one rebuilds in the background — so users stop hitting
// the cold path. Only successful (2xx) GETs are cached; errors are never stored.
//
// s-maxage=180 → the edge copy is "fresh" for 3 min (data revalidates often, so
//   predictions/fixtures stay current); the heavy rebuild mostly reuses already-
//   cached sub-data (team form, events, odds), so the extra revalidations are cheap.
// stale-while-revalidate=86400 → after that, the edge keeps serving the cached
//   copy for up to a day while it refreshes in the background. This is the key to
//   fast opens: a visitor after a quiet stretch gets an INSTANT stale response
//   instead of waiting for a cold function + cold cache to rebuild.
app.use("/api", (req, res, next) => {
  // /live sets its own short cache (scores must stay fresh); /health + the cron
  // warm trigger are uncached (they must run, never serve a cached body).
  if (req.method !== "GET" || req.path === "/health" || req.path === "/live" || req.path === "/cron/warm") return next();
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    res.set(
      "Cache-Control",
      res.statusCode >= 200 && res.statusCode < 300
        ? "public, s-maxage=180, stale-while-revalidate=86400"
        : "no-store"
    );
    return sendJson(body);
  };
  next();
});

app.use("/api", fixturesRouter);

// Server-rendered, crawlable SEO pages (/leagues, /league/:slug). Mounted outside
// /api so it isn't rate-limited or wrapped by the API cache middleware; it sets
// its own edge cache headers. vercel.json rewrites these paths to this function.
app.use("/", seoRouter);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    cache: cacheStats(),
    env: process.env.NODE_ENV,
    time: new Date().toISOString(),
  });
});

// Cache-warming trigger, hit by a Vercel Cron (see vercel.json `crons`). It
// requests the heavy cross-league aggregates THROUGH the edge for the audience
// timezone(s), today + tomorrow — so the edge/serverless caches stay hot and real
// users never trigger the cold cross-league build. Tomorrow is warmed too so the
// local-midnight date rollover is already built when it happens.
//
// WARM_TZS (comma-separated IANA zones) defaults to America/Toronto. Set
// CRON_SECRET in the Vercel project and the trigger requires Vercel's
// `Authorization: Bearer <CRON_SECRET>` header; without it the endpoint is open
// (harmless — it only warms caches — but setting the secret is recommended).
app.get("/api/cron/warm", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const tzs = (process.env.WARM_TZS || "America/Toronto")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const host = req.headers.host || "";
  // Vercel always sets x-forwarded-proto (https in prod); fall back by host so a
  // local dev run (http://localhost) warms correctly too.
  const proto = req.headers["x-forwarded-proto"] || (host.startsWith("localhost") ? "http" : "https");
  const base = `${proto}://${host}`;
  const ymdInTz = (tz, addDays) => {
    const d = new Date(Date.now() + addDays * 86400000);
    // en-CA formats as YYYY-MM-DD; timeZone buckets to that zone's local date.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  };

  const urls = [];
  for (const tz of tzs) {
    for (const addDays of [0, 1]) {
      const q = `date=${ymdInTz(tz, addDays)}&tz=${encodeURIComponent(tz)}`;
      urls.push(`${base}/api/today?${q}`);
      urls.push(`${base}/api/counts?${q}`);
    }
  }

  const started = Date.now();
  const settled = await Promise.allSettled(
    urls.map((u) => fetch(u).then((r) => r.status))
  );
  res.set("Cache-Control", "no-store");
  res.json({
    warmed: urls.map((u, i) => ({
      url: u,
      status: settled[i].status === "fulfilled" ? settled[i].value : "error",
    })),
    ms: Date.now() - started,
  });
});

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
