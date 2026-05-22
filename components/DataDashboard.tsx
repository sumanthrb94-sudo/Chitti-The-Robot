'use client';

/**
 * DataDashboard — renders an artifact returned by Chitti's tools.
 *
 * Supports: chart, table, metric, markdown.
 * Designed to live inside Team B's ConversationPanel.
 */

import { motion } from 'framer-motion';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn, formatNumber } from '@/lib/utils';
import type { Artifact, ChartData, QueryResult } from '@/types';

/* ─────────────────────────  Visual constants  ───────────────────────── */

const PALETTE = [
  '#00b8e6', // chitti-500
  '#9b6bff', // signal-violet
  '#4ddcff', // chitti-300
  '#00e5a8', // signal-green
  '#ffb020', // signal-amber
  '#ff3860', // signal-red
];

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgba(8,18,30,0.92)',
  border: '1px solid rgba(0,184,230,0.4)',
  borderRadius: 8,
  color: '#d6f5ff',
};

const AXIS_TICK = { fill: '#80e7ff', fontSize: 11 };
const GRID_STROKE = '#0090b333';

interface DataDashboardProps {
  artifact: Artifact;
  compact?: boolean;
}

/* ─────────────────────────  Helpers  ───────────────────────── */

function isNumericLike(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (isNumericLike(v)) return formatNumber(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ─────────────────────────  Charts  ───────────────────────── */

function ChartCanvas({
  chartType,
  data,
  compact,
}: {
  chartType: 'bar' | 'line' | 'area' | 'pie';
  data: ChartData;
  compact: boolean;
}) {
  const height = compact ? 220 : 320;
  const { xKey, yKeys, rows } = data;

  if (chartType === 'pie') {
    const yKey = yKeys[0];
    const pieRows = rows.map((r) => ({
      name: String(r[xKey] ?? ''),
      value: typeof r[yKey] === 'number' ? (r[yKey] as number) : Number(r[yKey] ?? 0),
    }));
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={pieRows}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={compact ? 70 : 100}
            label={(entry: { name?: string; percent?: number }) => {
              const name = entry.name ?? '';
              const pct =
                typeof entry.percent === 'number'
                  ? `${Math.round(entry.percent * 100)}%`
                  : '';
              return pct ? `${name} ${pct}` : name;
            }}
            labelLine={false}
            stroke="#02060c"
            strokeWidth={1}
          >
            {pieRows.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_STYLE} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'line') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ stroke: '#00b8e6', strokeOpacity: 0.3 }} />
          <Legend wrapperStyle={{ color: '#80e7ff', fontSize: 11 }} />
          {yKeys.map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2}
              dot={{ r: 2, fill: PALETTE[i % PALETTE.length] }}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <defs>
            {yKeys.map((k, i) => (
              <linearGradient
                key={k}
                id={`area-grad-${i}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={PALETTE[i % PALETTE.length]}
                  stopOpacity={0.7}
                />
                <stop
                  offset="95%"
                  stopColor={PALETTE[i % PALETTE.length]}
                  stopOpacity={0.05}
                />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ color: '#80e7ff', fontSize: 11 }} />
          {yKeys.map((k, i) => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              stroke={PALETTE[i % PALETTE.length]}
              fill={`url(#area-grad-${i})`}
              stackId="1"
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // default: bar
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
        <XAxis
          dataKey={xKey}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: 'rgba(0,184,230,0.08)' }}
        />
        <Legend wrapperStyle={{ color: '#80e7ff', fontSize: 11 }} />
        {yKeys.map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            fill={PALETTE[i % PALETTE.length]}
            radius={[4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ─────────────────────────  Table  ───────────────────────── */

function DataTable({ data }: { data: QueryResult }) {
  const visible = data.rows.slice(0, 50);
  const cols = data.columns.length > 0
    ? data.columns
    : visible[0]
      ? Object.keys(visible[0])
      : [];

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-auto max-h-[420px] rounded border border-chitti-500/20">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-chitti-900/95 backdrop-blur">
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  className="text-left px-3 py-2 text-chitti-300 font-semibold border-b border-chitti-500/30 whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(1, cols.length)}
                  className="px-3 py-4 text-center text-chitti-500/70"
                >
                  No rows.
                </td>
              </tr>
            )}
            {visible.map((row, i) => (
              <tr
                key={i}
                className={cn(
                  'border-b border-chitti-500/10',
                  i % 2 === 0 ? 'bg-chitti-900/20' : 'bg-transparent',
                )}
              >
                {cols.map((c) => (
                  <td
                    key={c}
                    className="px-3 py-1.5 text-chitti-100 whitespace-nowrap"
                  >
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-[11px] text-chitti-500/70 font-mono">
        <span>
          Showing {visible.length} of {data.rowCount}
          {data.rowCount === 1000 ? ' (capped)' : ''}
          {' · '}
          {data.durationMs} ms
        </span>
      </div>
      {data.sql && (
        <pre className="font-mono text-[11px] text-chitti-500/70 whitespace-pre-wrap break-words border-l-2 border-chitti-500/30 pl-2">
          {data.sql}
        </pre>
      )}
    </div>
  );
}

/* ─────────────────────────  Metric  ───────────────────────── */

function MetricCard({
  label,
  value,
  delta,
}: {
  label: string;
  value: string | number;
  delta?: number;
}) {
  const display =
    typeof value === 'number' ? formatNumber(value) : String(value);
  const positive = typeof delta === 'number' && delta >= 0;

  return (
    <div className="flex flex-col gap-2 p-2">
      <span className="text-xs uppercase tracking-widest text-chitti-300/80 font-mono">
        {label}
      </span>
      <span className="font-display text-4xl md:text-5xl text-glow text-chitti-100 leading-none">
        {display}
      </span>
      {typeof delta === 'number' && (
        <span
          className={cn(
            'flex items-center gap-1 text-sm font-mono',
            positive ? 'text-signal-green' : 'text-signal-red',
          )}
        >
          {positive ? (
            <ArrowUpRight className="w-4 h-4" />
          ) : (
            <ArrowDownRight className="w-4 h-4" />
          )}
          {positive ? '+' : ''}
          {delta}%
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────  Root  ───────────────────────── */

export function DataDashboard({
  artifact,
  compact = false,
}: DataDashboardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className="glass-strong hud-corners border border-chitti-500/30 rounded-lg p-4"
    >
      {artifact.kind === 'chart' && (
        <div className="flex flex-col gap-3">
          {artifact.title && (
            <div className="hud-corners pb-2">
              <h3 className="font-display text-sm tracking-widest uppercase text-chitti-200 text-glow">
                {artifact.title}
              </h3>
            </div>
          )}
          <ChartCanvas
            chartType={artifact.chartType}
            data={artifact.data}
            compact={compact}
          />
        </div>
      )}

      {artifact.kind === 'table' && <DataTable data={artifact.data} />}

      {artifact.kind === 'metric' && (
        <MetricCard
          label={artifact.label}
          value={artifact.value}
          delta={artifact.delta}
        />
      )}

      {artifact.kind === 'markdown' && (
        <div className="whitespace-pre-wrap text-sm text-chitti-100 leading-relaxed font-sans">
          {artifact.text}
        </div>
      )}
    </motion.div>
  );
}

export default DataDashboard;
