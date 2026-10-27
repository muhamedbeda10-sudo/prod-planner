import type { CSSProperties } from "react";

// No hooks and no "use client": a plain span any server or client screen can draw.

/** The app's one progress bar: a share of its whole, the fill in `color` on
 *  a lighter track of the same hue (.meter in globals.css), with an optional
 *  tick where it should be (`mark`: a target, a limit, an allowance). Given a
 *  `label` it is a meter a screen reader names; without one it only repeats
 *  a figure written beside it and stays out of the reading. */
export function Meter({ value, color, mark = null, size = "md", label, valueText, className = "" }: {
  /** The share filled, 0..1 (clamped). */
  value: number;
  /** The fill's colour; the track is a tint of it. The chart accent by default. */
  color?: string;
  /** A tick at this share, 0..1 (clamped). */
  mark?: number | null;
  size?: "sm" | "md" | "lg";
  label?: string;
  /** What a screen reader says for the value — the figure as written beside the bar ("150%", "3 of 5"). */
  valueText?: string;
  className?: string;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const v = clamp(value);
  return (
    <span
      className={`meter meter-${size} ${className}`}
      style={color ? ({ "--meter-color": color } as CSSProperties) : undefined}
      {...(label
        ? { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(v * 100), "aria-valuetext": valueText }
        : { "aria-hidden": true })}
    >
      <span className="meter-fill" style={{ width: `${v * 100}%` }} />
      {mark !== null && <span className="meter-mark" style={{ insetInlineStart: `calc(${clamp(mark) * 100}% - 1px)` }} />}
    </span>
  );
}
