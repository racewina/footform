import { useEffect, useRef, useState } from "react";

// Pull-to-refresh for touch devices. Android Chrome ships this natively; iOS
// Safari (and every standalone PWA) does not, so the two platforms felt
// inconsistent. This adds the same gesture everywhere: at the top of the
// scroll, drag down past a threshold to refresh.
//
// It wraps the page region rather than any single scroller, and on touchstart
// walks up from the touched element to the real scroll container — the pages
// each own an inner `overflow-y: auto` area — so the gesture only arms when THAT
// container is already at the top. Normal scrolling is never intercepted.

const THRESHOLD = 70; // px of pull that commits a refresh
const MAX = 120; // px the indicator/content can travel
const DAMP = 0.5; // resistance, so the pull feels rubber-banded
const MIN_SPIN_MS = 600; // keep the spinner up briefly so a fast refetch isn't a flash

export default function PullToRefresh({ onRefresh, children }) {
  const wrapRef = useRef(null);
  const drag = useRef({ active: false, startY: 0, scroller: null });
  const pullRef = useRef(0);
  const [pull, setPull] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const setPullBoth = (v) => {
    pullRef.current = v;
    setPull(v);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    // Nearest scrollable ancestor of the touch target, stopping at the wrapper.
    const scrollerOf = (node) => {
      for (let n = node; n && n !== el.parentNode; n = n.parentElement) {
        if (n === el) return null; // reached the wrapper without finding a scroller
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
      }
      return null;
    };

    const onStart = (e) => {
      if (refreshing || e.touches.length !== 1) return;
      const sc = scrollerOf(e.target);
      if (sc && sc.scrollTop > 0) { drag.current.active = false; return; } // not at top
      drag.current = { active: true, startY: e.touches[0].clientY, scroller: sc };
    };

    const onMove = (e) => {
      if (!drag.current.active) return;
      const dy = e.touches[0].clientY - drag.current.startY;
      const sc = drag.current.scroller;
      // Pulling up, or the scroller has moved off the top → hand the gesture back.
      if (dy <= 0 || (sc && sc.scrollTop > 0)) {
        if (pullRef.current !== 0) setPullBoth(0);
        drag.current.active = false;
        setDragging(false);
        return;
      }
      const dist = Math.min(MAX, dy * DAMP);
      if (dist > 4) {
        e.preventDefault(); // take over the gesture, suppress iOS overscroll bounce
        if (!dragging) setDragging(true);
      }
      setPullBoth(dist);
    };

    const onEnd = () => {
      if (!drag.current.active) return;
      drag.current.active = false;
      setDragging(false);
      if (pullRef.current >= THRESHOLD) {
        setRefreshing(true);
        setPullBoth(THRESHOLD * 0.85); // hold at the spinner's resting height
        const started = Date.now();
        Promise.resolve()
          .then(() => onRefresh?.())
          .catch(() => {})
          .finally(() => {
            const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - started));
            setTimeout(() => {
              setRefreshing(false);
              setPullBoth(0);
            }, wait);
          });
      } else {
        setPullBoth(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [refreshing, dragging, onRefresh]);

  const progress = Math.min(1, pull / THRESHOLD);
  const armed = pull >= THRESHOLD;
  // Smoothly settle back / into the resting spin position when not finger-dragging.
  const transition = dragging ? "none" : "transform 0.2s ease-out";

  return (
    <div ref={wrapRef} style={styles.wrap}>
      <div
        style={{
          ...styles.indicator,
          transform: `translate(-50%, ${pull - 44}px)`,
          opacity: pull > 6 ? 1 : 0,
          transition,
        }}
        aria-hidden="true"
      >
        <div
          style={{
            ...styles.spinner,
            ...(refreshing ? styles.spinning : null),
            transform: refreshing ? "none" : `rotate(${progress * 270}deg)`,
            borderTopColor: armed || refreshing ? "var(--accent)" : "var(--text3)",
          }}
        />
      </div>
      <div style={{ ...styles.content, transform: `translateY(${pull}px)`, transition }}>
        {children}
      </div>
    </div>
  );
}

const styles = {
  wrap: { position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
  content: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", willChange: "transform" },
  indicator: { position: "absolute", top: 0, left: "50%", zIndex: 20, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: "var(--bg2)", boxShadow: "0 2px 8px rgba(0,0,0,0.25)", pointerEvents: "none" },
  spinner: { width: 18, height: 18, borderRadius: "50%", border: "2.5px solid var(--border)", borderTopColor: "var(--text3)" },
  spinning: { animation: "spin 0.7s linear infinite" },
};
