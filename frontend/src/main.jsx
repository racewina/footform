import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA + auto-update (production builds only, so it never interferes with the Vite
// dev server / HMR). Between the always-fresh HTML (cache headers) and this, the
// app self-updates instead of needing manual refreshes.
if (import.meta.env.PROD) {
  // The bundle URL this page loaded — index.html is content-hashed per build, so
  // a different hash means a new deploy is live.
  const loadedBundle =
    [...document.scripts].map((s) => s.src).find((s) => /\/assets\/index-[^/]*\.js$/.test(s)) || "";

  let reloading = false;
  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };

  // Fetch the (uncached) HTML and compare its bundle hash to the one running.
  const checkForUpdate = async () => {
    if (!loadedBundle || document.hidden) return;
    try {
      const html = await fetch("/", { cache: "no-store" }).then((r) => r.text());
      const latest = (html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0];
      if (latest && !loadedBundle.endsWith(latest)) reloadOnce();
    } catch {
      /* offline / transient — ignore */
    }
  };

  // Re-check whenever the user returns to the app (least disruptive moment).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdate();
  });
  // And a slow heartbeat for long-lived open tabs.
  setInterval(checkForUpdate, 15 * 60 * 1000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
    // When a new service worker takes control, reload once for a consistent version.
    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
  }
}
