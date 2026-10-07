'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from '../../lib/useReducedMotion';

/**
 * A beautiful, on-brand, ticking analog clock face — purely decorative
 * ("feels alive"), showing the VIEWER'S OWN current wall-clock time (not a
 * representation of elapsed worked time — see `GoalRing` in `ClockWidget.tsx`
 * for that). Step 8.1 Part 3 — docs/conventions/attendance-ui.md. Ticks every
 * second via a plain `setInterval`; `prefers-reduced-motion` drops the sweep
 * transition so the hands jump to position instead of easing (see
 * `useReducedMotion`).
 */

const TICKS = Array.from({ length: 12 }, (_, i) => i);

/**
 * Unrotated, the hand sits directly ABOVE the center (bottom edge pinned to
 * the center point, `transformOrigin: 50% 100%`) — pointing at 12 o'clock —
 * so `rotate(angleDeg)` with `angleDeg` measured clockwise from 12 (the
 * standard clock-angle convention used below) sweeps it to the right place.
 */
function Hand({ angleDeg, length, width, color, transition }: { angleDeg: number; length: number; width: number; color: string; transition: boolean }) {
  return (
    <div
      aria-hidden
      className={`absolute left-1/2 top-1/2 rounded-full ${transition ? 'transition-transform duration-200 ease-out motion-reduce:transition-none' : ''}`}
      style={{
        width,
        height: length,
        marginLeft: -width / 2,
        marginTop: -length,
        transformOrigin: '50% 100%',
        transform: `rotate(${angleDeg}deg)`,
        backgroundColor: color,
      }}
    />
  );
}

export function LiveAnalogClock({ size = 168, className = '' }: { size?: number; className?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Avoid an SSR/first-paint mismatch (the server has no "now"); render a
  // static face at 12:00:00 until the first client tick lands.
  const t = now ?? new Date(0);
  const hours = t.getHours() % 12;
  const minutes = t.getMinutes();
  const seconds = t.getSeconds();

  const hourAngle = (hours * 60 + minutes) * (360 / (12 * 60));
  const minuteAngle = (minutes * 60 + seconds) * (360 / (60 * 60));
  const secondAngle = seconds * (360 / 60);

  const radius = size / 2;

  return (
    <div
      role="img"
      aria-label={t.toLocaleTimeString()}
      data-testid="live-analog-clock"
      className={`relative shrink-0 rounded-full border border-ink-100 bg-surface shadow-card ${className}`}
      style={{ width: size, height: size }}
    >
      {TICKS.map((i) => {
        const major = i % 3 === 0;
        const dim = major ? 3.5 : 2;
        const r = radius - 12;
        const angleRad = (i * 30 * Math.PI) / 180;
        const x = radius + r * Math.sin(angleRad);
        const y = radius - r * Math.cos(angleRad);
        return (
          <div
            key={i}
            aria-hidden
            className={`absolute rounded-full ${major ? 'bg-brand-600' : 'bg-ink-200'}`}
            style={{ width: dim, height: dim, left: x, top: y, transform: 'translate(-50%, -50%)' }}
          />
        );
      })}

      <Hand angleDeg={hourAngle} length={radius * 0.5} width={5} color="rgb(var(--c-ink-900))" transition={!reducedMotion} />
      <Hand angleDeg={minuteAngle} length={radius * 0.72} width={3.5} color="rgb(var(--c-brand-600))" transition={!reducedMotion} />
      <Hand angleDeg={secondAngle} length={radius * 0.78} width={1.5} color="rgb(var(--c-accent-500))" transition={!reducedMotion} />

      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600 ring-2 ring-surface"
      />
    </div>
  );
}
