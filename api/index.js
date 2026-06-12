// Vercel serverless entry. A rewrite in vercel.json sends every /api/* request
// here; the original path is preserved so the Express app (mounted at /api)
// routes it correctly. The dependency tracer pulls in the backend services
// (apifootball, predictions, cache) automatically via this static import.
import app from "../backend/src/app.js";

export default app;
