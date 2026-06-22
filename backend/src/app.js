import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fixturesRouter from "./routes/fixtures.js";
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
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" || req.path === "/health") return next();
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    res.set(
      "Cache-Control",
      res.statusCode >= 200 && res.statusCode < 300
        ? "public, s-maxage=600, stale-while-revalidate=3600"
        : "no-store"
    );
    return sendJson(body);
  };
  next();
});

app.use("/api", fixturesRouter);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    cache: cacheStats(),
    env: process.env.NODE_ENV,
    time: new Date().toISOString(),
  });
});

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
