// «At work»: three dots orbiting in 3D, as Claude's own apps show it (owner 2026-11-11, with a screen
// recording: «چند تا نقطه که دوران پیدا می‌کنن»), instead of a plain spinning ring; while a tool runs, its
// other shape — four dots in a square that slides into a line and back (shape="grid"). Styles: .dots-spin (styles.css).
const ORBIT = [0, 1, 2].map((i) => ({ "--i": i }));
// --d: the dot's place on the diagonal line the square slides into.
const GRID = [[-1, -1, -0.5], [1, -1, 1.5], [-1, 1, -1.5], [1, 1, 0.5]].map(([x, y, d]) => ({ "--x": x, "--y": y, "--d": d }));

// The theme's colour (owner 2026-11-12: «رنگ لودینگه یکسان باشه با تم»); a className with its own text
// colour replaces it.
export function DotsSpinner({ className = "text-primary", label = null, shape = "orbit" }) {
  const dots = shape === "grid" ? GRID : ORBIT;
  return (
    <span className={`dots-spin ${shape === "grid" ? "grid" : ""} ${className}`} role={label ? "status" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
      <span><span>{dots.map((style, i) => <i key={i} style={style} />)}</span></span>
    </span>
  );
}
