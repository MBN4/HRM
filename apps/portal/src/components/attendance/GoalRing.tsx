'use client';

/**
 * A circular progress ring for "elapsed worked time vs. the policy's
 * `requiredHours` goal" — step 8.1 Part 3, docs/conventions/attendance-ui.md.
 * Purely a renderer: the caller computes `progress` (0-1, can exceed 1 once
 * the goal is passed) from the server-anchored `clockIn` instant; this
 * component fabricates nothing. `motion-safe:` eases the fill in; under
 * `prefers-reduced-motion` it jumps straight to the current value.
 */
export function GoalRing({
  progress,
  size = 168,
  strokeWidth = 10,
  children,
}: {
  /** 0-1 toward the goal; values above 1 render a full ring (the "over goal" state is conveyed by the caller's own text/badge, not the ring). */
  progress: number;
  size?: number;
  strokeWidth?: number;
  children?: React.ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1, progress));
  const overGoal = progress > 1;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} data-testid="goal-ring" data-progress={clamped.toFixed(2)} data-over-goal={overGoal}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" dir="ltr" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-sand-200" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className={`motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-out ${overGoal ? 'stroke-brand-500' : 'stroke-accent-500'}`}
        />
      </svg>
      {children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
    </div>
  );
}
