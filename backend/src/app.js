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
