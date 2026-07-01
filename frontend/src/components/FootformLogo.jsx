// FootForm brand mark. The football circle is split in two: the upper half is
// the classic pentagon patch + seam lines (football), the lower half is three
// ascending bars with a trend line (analytics). Adapted from the brand file.

const ACCENT = "#4DFFB4"; // mint
const BALL_BG = "#0D1F35"; // navy

export function FootformIcon({ size = 42, color = ACCENT, bg = BALL_BG, uid = "a" }) {
  const s = size;
  const cx = s / 2,
    cy = s / 2;
  const R = s * 0.44;
  const clipId = `ball-clip-${uid}-${size}`;

  // Pentagon centre: upper portion of ball.
  const px = cx,
    py = cy - R * 0.26;
  const pr = R * 0.33;
  const ppts = Array.from({ length: 5 }, (_, i) => {
    const a = (2 * Math.PI * i) / 5 - Math.PI / 2;
    return [px + pr * Math.cos(a), py + pr * Math.sin(a)];
  });
  const pentPath =
    ppts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ") + " Z";

  // Seam lines: from each pentagon vertex extending to the ball edge.
  const seamLines = ppts
    .map(([vx, vy]) => {
      const dx = vx - px,
        dy = vy - py;
      const len = Math.sqrt(dx * dx + dy * dy);
      const ndx = dx / len,
        ndy = dy / len;
      const ax = vx - cx,
        ay = vy - cy;
      const b = 2 * (ax * ndx + ay * ndy);
      const c = ax * ax + ay * ay - R * R;
      const disc = b * b - 4 * c;
      if (disc < 0) return null;
      const t = (-b + Math.sqrt(disc)) / 2;
      return { x1: vx, y1: vy, x2: vx + t * ndx, y2: vy + t * ndy };
    })
    .filter(Boolean);

  // Bars — lower half of ball.
  const barW = s * 0.082;
  const barGap = s * 0.052;
  const baseY = cy + R * 0.64;
  const bars = [
    { x: cx - barW * 1.5 - barGap, h: R * 0.28 },
    { x: cx - barW / 2, h: R * 0.48 },
    { x: cx + barW / 2 + barGap, h: R * 0.66 },
  ];

  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <circle cx={cx} cy={cy} r={R - s * 0.015} />
        </clipPath>
      </defs>

      <circle cx={cx} cy={cy} r={R} fill={bg} stroke={color} strokeWidth={s * 0.044} />

      <g clipPath={`url(#${clipId})`}>
        {seamLines.map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={color}
            strokeWidth={s * 0.022}
            opacity={0.28}
            strokeLinecap="round"
          />
        ))}

        <path
          d={pentPath}
          fill={color}
          fillOpacity={0.13}
          stroke={color}
          strokeWidth={s * 0.024}
          strokeOpacity={0.45}
          strokeLinejoin="round"
        />

        <line
          x1={cx - R * 0.72}
          y1={cy + R * 0.08}
          x2={cx + R * 0.72}
          y2={cy + R * 0.08}
          stroke={color}
          strokeWidth={s * 0.016}
          opacity={0.18}
        />

        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={baseY - bar.h}
            width={barW}
            height={bar.h}
            rx={barW * 0.32}
            fill={color}
            opacity={0.18 + i * 0.3}
          />
        ))}

        <polyline
          points={bars.map((b) => `${b.x + barW / 2},${baseY - b.h}`).join(" ")}
          stroke={color}
          strokeWidth={s * 0.048}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </g>
    </svg>
  );
}

// Icon + "FootForm" wordmark ("Form" in the mint accent). `wordSize` sizes the text.
export function FootformLogo({ iconSize = 34, wordSize = 19, uid = "logo" }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: iconSize * 0.32 }}>
      <FootformIcon size={iconSize} uid={uid} />
      <span
        style={{
          fontFamily: "var(--font-display), 'Inter', system-ui, sans-serif",
          fontSize: wordSize,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          lineHeight: 1,
          color: "var(--text)",
        }}
      >
        Foot<span style={{ color: ACCENT }}>Form</span>
      </span>
    </span>
  );
}

export default FootformLogo;
