"use client";

import { useId, useState } from "react";
import type { MonthlyGrowthPoint } from "@/lib/domain/types";
import { formatInt, formatMonth } from "@/lib/domain/format";

/**
 * Six-month growth: one column per month showing average records added per
 * day, with the six-month average as a reference line. Single series → no
 * legend box; the title names it. Hover/focus shows exact values and a
 * visually-hidden table carries the same data for assistive tech.
 */
export function GrowthChart({
  points,
  average,
  tableName,
  height = 170,
}: {
  points: MonthlyGrowthPoint[];
  average: number;
  tableName: string;
  height?: number;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const perDay = points.map((p) => Math.round(p.recordsAdded / p.daysInMonth));
  const rawMax = Math.max(1, ...perDay, average);
  const step = niceStep(rawMax / 3);
  const yMax = Math.ceil(rawMax / step) * step;
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);

  const W = 560;
  const padL = 44;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = height - padT - padB;
  const band = plotW / Math.max(1, points.length);
  const barW = Math.min(24, band * 0.55);
  const y = (v: number) => padT + plotH - (v / yMax) * plotH;

  if (points.length === 0) {
    return <p className="py-6 text-center text-xs text-ink-3">No growth history available.</p>;
  }

  const hp = hover !== null ? points[hover] : undefined;

  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full" role="img" aria-labelledby={`${id}-cap`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={padL - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--color-ink-3)" className="num">
              {formatInt(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const v = perDay[i] ?? 0;
          const cx = padL + band * i + band / 2;
          const top = y(v);
          const h = Math.max(0, padT + plotH - top);
          const r = Math.min(4, h);
          return (
            <g
              key={p.month}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              role="img"
              aria-label={`${formatMonth(p.month)}: ${formatInt(v)} records per day`}
              className="outline-none"
            >
              <rect x={padL + band * i} y={padT} width={band} height={plotH} fill={hover === i ? "var(--color-surface-2)" : "transparent"} />
              <path
                d={`M${cx - barW / 2},${padT + plotH} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${padT + plotH} Z`}
                fill="var(--color-accent)"
                opacity={hover === null || hover === i ? 1 : 0.55}
              />
              <text x={cx} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--color-ink-3)">
                {formatMonth(p.month)}
              </text>
            </g>
          );
        })}
        {/* 6-month average reference line */}
        <line x1={padL} x2={W - padR} y1={y(average)} y2={y(average)} stroke="var(--color-ink)" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
        <text
          x={padL + 4}
          y={y(average) - 5}
          fontSize={10}
          fontWeight={600}
          fill="var(--color-ink)"
          stroke="var(--color-surface)"
          strokeWidth={3}
          paintOrder="stroke"
          pointerEvents="none"
        >
          6-mo avg {formatInt(average)}/day
        </text>
      </svg>
      {hp && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-[11px] shadow-md"
          style={{ left: `${((padL + band * hover + band / 2) / W) * 100}%` }}
        >
          <div className="font-semibold">{formatMonth(hp.month)}</div>
          <div className="num text-ink-2">{formatInt(perDay[hover])} records/day</div>
          <div className="num text-ink-3">{formatInt(hp.recordsAdded)} added in month</div>
        </div>
      )}
      <figcaption id={`${id}-cap`} className="sr-only">
        Average records added per day for {tableName}, last six months. Six-month average {formatInt(average)} per day.
      </figcaption>
      <table className="sr-only">
        <caption>Monthly growth for {tableName}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Records added</th>
            <th scope="col">Average per day</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={p.month}>
              <td>{formatMonth(p.month)}</td>
              <td>{formatInt(p.recordsAdded)}</td>
              <td>{formatInt(perDay[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}
