'use client';

import { useEffect, useId, useState } from 'react';

/** Wall-clock parts of `instant` in `timeZone` (the member's BRANCH timezone — the clock shows the time their shift is measured in). */
function partsInZone(instant: Date, timeZone: string): { h: number; m: number; s: number; ms: number } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const get = (type: string) => Number(f.formatToParts(instant).find((p) => p.type === type)?.value ?? 0);
  return { h: get('hour'), m: get('minute'), s: get('second'), ms: instant.getMilliseconds() };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** `now`, re-rendered every animation frame (smooth sweep) — or once a second when the user prefers reduced motion. */
export function useNow(smooth: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (smooth) {
      let raf = 0;
      const loop = () => {
        setNow(new Date());
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [smooth]);
  return now;
}

export interface AnalogClockProps {
  timeZone: string;
  /** 0..1 — fills the ring around the face (worked ÷ required). Omit to hide the ring. */
  progress?: number;
  /** The ring colour once `progress >= 1` stays the same hue; `live` adds the soft glow + pulsing centre dot. */
  live?: boolean;
  label: string;
  size?: number;
}

const CX = 110;
const RING_R = 102;
const FACE_R = 92;

/**
 * The live analog clock (step 8.1 Part 3). Pure SVG, token-coloured (so it re-themes with light/dark),
 * and wrapped in `dir="ltr"` — a clock face turns clockwise in every locale, RTL included, so the face is
 * deliberately NOT mirrored. The second hand sweeps per animation frame; under `prefers-reduced-motion`
 * it ticks once a second and the glow/pulse are off (the time itself is information, not decoration).
 */
export function AnalogClock({ timeZone, progress, live = false, label, size = 220 }: AnalogClockProps) {
  const reduced = usePrefersReducedMotion();
  const now = useNow(!reduced);
  const gradId = useId();
  const { h, m, s, ms } = partsInZone(now, timeZone);
  const sec = reduced ? s : s + ms / 1000;
  const secDeg = sec * 6;
  const minDeg = (m + sec / 60) * 6;
  const hourDeg = ((h % 12) + m / 60) * 30;
  const circumference = 2 * Math.PI * RING_R;
  const pct = progress === undefined ? 0 : Math.max(0, Math.min(1, progress));

  return (
    <div dir="ltr" className="shrink-0" style={{ width: size, height: size }} data-testid="analog-clock" data-live={live ? 'true' : 'false'}>
      <svg viewBox="0 0 220 220" width={size} height={size} role="img" aria-label={label}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgb(var(--c-accent-400))" />
            <stop offset="100%" stopColor="rgb(var(--c-brand-500))" />
          </linearGradient>
        </defs>

        {/* progress ring: a faint track + the filling arc, starting at 12 o'clock */}
        {progress !== undefined && (
          <g transform={`rotate(-90 ${CX} ${CX})`}>
            <circle cx={CX} cy={CX} r={RING_R} fill="none" stroke="rgb(var(--c-ink-100))" strokeWidth="8" />
            <circle
              data-testid="clock-progress-ring"
              data-progress={pct.toFixed(3)}
              cx={CX}
              cy={CX}
              r={RING_R}
              fill="none"
              stroke={`url(#${gradId})`}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - pct)}
              className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-linear"
            />
          </g>
        )}

        {/* face */}
        <circle cx={CX} cy={CX} r={FACE_R} fill="rgb(var(--c-surface))" stroke="rgb(var(--c-ink-200))" strokeWidth="1.5" />
        {live && !reduced && <circle cx={CX} cy={CX} r={FACE_R} fill="none" stroke="rgb(var(--c-accent-400))" strokeOpacity="0.35" strokeWidth="6" className="animate-pulse" />}

        {/* ticks */}
        {Array.from({ length: 60 }, (_, i) => {
          const major = i % 5 === 0;
          const a = (i * 6 * Math.PI) / 180;
          const r1 = FACE_R - 4;
          const r2 = FACE_R - (major ? 13 : 8);
          return (
            <line
              key={i}
              x1={CX + Math.sin(a) * r1}
              y1={CX - Math.cos(a) * r1}
              x2={CX + Math.sin(a) * r2}
              y2={CX - Math.cos(a) * r2}
              stroke={major ? 'rgb(var(--c-ink-700))' : 'rgb(var(--c-ink-300))'}
              strokeWidth={major ? 2 : 1}
              strokeLinecap="round"
            />
          );
        })}

        {/* numerals at the quarters */}
        {[12, 3, 6, 9].map((n) => {
          const a = ((n % 12) * 30 * Math.PI) / 180;
          return (
            <text
              key={n}
              x={CX + Math.sin(a) * 66}
              y={CX - Math.cos(a) * 66}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="15"
              fontWeight="600"
              fill="rgb(var(--c-ink-600))"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {n}
            </text>
          );
        })}

        {/* hands */}
        <g data-testid="hour-hand" transform={`rotate(${hourDeg} ${CX} ${CX})`}>
          <line x1={CX} y1={CX + 8} x2={CX} y2={CX - 44} stroke="rgb(var(--c-ink-900))" strokeWidth="5" strokeLinecap="round" />
        </g>
        <g data-testid="minute-hand" transform={`rotate(${minDeg} ${CX} ${CX})`}>
          <line x1={CX} y1={CX + 10} x2={CX} y2={CX - 64} stroke="rgb(var(--c-ink-800))" strokeWidth="3.5" strokeLinecap="round" />
        </g>
        <g data-testid="second-hand" data-second-deg={secDeg.toFixed(1)} transform={`rotate(${secDeg} ${CX} ${CX})`}>
          <line x1={CX} y1={CX + 18} x2={CX} y2={CX - 74} stroke="rgb(var(--c-accent-500))" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx={CX} cy={CX - 74} r="2.6" fill="rgb(var(--c-accent-500))" />
        </g>
        <circle cx={CX} cy={CX} r="5" fill="rgb(var(--c-accent-500))" />
        <circle cx={CX} cy={CX} r="2" fill="rgb(var(--c-surface))" />
      </svg>
    </div>
  );
}
