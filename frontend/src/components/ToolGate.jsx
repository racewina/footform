import { useState, useEffect } from "react";

// Shared password gate for the private generator tools (Odds / Corner / Event).
// The code is validated SERVER-SIDE — the bundle never contains it. It's stored
// under the same key the Odds Generator uses, so unlocking one unlocks all three,
// and every gated request carries it as the `x-odds-pass` header.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PASS_KEY = "footform_og_pass";
const LOCK_EVENT = "footform-tools-locked";

export function getToolPass() {
  try { return localStorage.getItem(PASS_KEY) || ""; } catch { return ""; }
}
// Forget the code and drop every mounted tool back to its lock (used on a 401).
export function clearToolPass() {
  try { localStorage.removeItem(PASS_KEY); } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCK_EVENT));
}
// Ask the server whether a code is valid (the Odds endpoint 200s for a good code
// with no leagues, 401s otherwise) — so nothing here reveals the code itself.
async function verifyPass(code) {
  try {
    const res = await fetch(`/api/odds-generator?tz=${encodeURIComponent(TZ)}`, {
      headers: { "x-odds-pass": code },
    });
    return res.ok;
  } catch { return false; }
}

export default function ToolGate({ title, children }) {
  const [authed, setAuthed] = useState(() => !!getToolPass());
  useEffect(() => {
    const relock = () => setAuthed(false);
    window.addEventListener(LOCK_EVENT, relock);
    return () => window.removeEventListener(LOCK_EVENT, relock);
  }, []);
  if (authed) return children;
  return <Lock title={title} onUnlock={() => setAuthed(true)} />;
}

function Lock({ title, onUnlock }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true); setErr("");
    try {
      if (await verifyPass(code)) { try { localStorage.setItem(PASS_KEY, code); } catch {} onUnlock(); }
      else setErr("Incorrect code.");
    } catch {
      setErr("Couldn't verify — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.wrap}>
      <form style={styles.card} onSubmit={submit}>
        <div style={styles.icon} aria-hidden="true">🔒</div>
        <div style={styles.title}>{title}</div>
        <div style={styles.sub}>This tool is private. Enter the access code to continue.</div>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={code}
          onChange={(e) => { setCode(e.target.value); setErr(""); }}
          placeholder="Access code"
          style={styles.input}
          aria-label="Access code"
        />
        {err && <div style={styles.err}>{err}</div>}
        <button type="submit" disabled={!code || busy} style={{ ...styles.btn, ...(code && !busy ? {} : styles.btnOff) }}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

const styles = {
  wrap: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  card: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 16, padding: "28px 26px", width: "100%", maxWidth: 340 },
  icon: { fontSize: 30 },
  title: { fontSize: 17, fontWeight: 700, color: "var(--text)" },
  sub: { fontSize: 12.5, color: "var(--text3)", lineHeight: 1.45, marginBottom: 4 },
  input: { width: "100%", textAlign: "center", letterSpacing: 3, fontSize: 18, background: "var(--bg3)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" },
  err: { fontSize: 12.5, color: "var(--loss)" },
  btn: { width: "100%", fontSize: 14, fontWeight: 700, color: "#04121f", background: "var(--accent)", border: "none", borderRadius: 10, padding: "10px 16px", cursor: "pointer" },
  btnOff: { opacity: 0.4, cursor: "not-allowed" },
};
