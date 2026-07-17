"use client";

// Shared presentational primitives. Extracted from CutCoachApp so NotificationSettings
// can use them without importing back into its own parent (which would be circular).

export function Eyebrow({ children, color = "text-slate-500" }) {
  return <div className={`text-xs font-semibold uppercase tracking-widest ${color}`}>{children}</div>;
}

export function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-slate-800 bg-slate-900 p-4 ${className}`}>
      {children}
    </div>
  );
}

export function Bar({ value, max, color }) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0);
  const over = value > max;
  return (
    <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
      <div
        className={`h-full rounded-full ${over ? "bg-rose-400" : color}`}
        style={{ width: `${pct}%`, transition: "width 300ms ease" }}
      />
    </div>
  );
}
