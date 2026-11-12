"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: string;
};

const variants = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "bg-well text-ink border border-line-strong hover:border-ink-2",
  ghost: "text-ink-2 hover:bg-well hover:text-ink",
  danger: "border border-ink text-ink hover:bg-ink hover:text-paper",
};

const sizes = { sm: "h-8 px-3 text-sm gap-1.5", md: "h-10 px-4 text-[15px] gap-2", lg: "h-12 px-6 text-base gap-2" };

export function Button({ variant = "primary", size = "md", loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap",
        "transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] active:translate-y-px",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <i className="ri-loader-4-line animate-spin" aria-hidden /> : icon ? <i className={icon} aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Card({ className, children, as: Tag = "section" }: { className?: string; children: ReactNode; as?: "section" | "div" | "article" }) {
  return <Tag className={cx("glass-card rounded-card", className)}>{children}</Tag>;
}

export function CardHeader({ title, action, hint }: { title: ReactNode; action?: ReactNode; hint?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-3 px-5 pt-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-medium text-ink">{title}</h2>
        {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      </div>
      {action}
    </header>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | null; suffix?: ReactNode };

export function Field({ label, hint, error, suffix, id, className, ...rest }: InputProps) {
  const fieldId = id ?? `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <label htmlFor={fieldId} className={cx("block", className)}>
      <span className="mb-1.5 block text-sm text-ink-2">{label}</span>
      <span
        className={cx(
          "flex h-11 items-center rounded-control border bg-well px-3 transition-[border-color] duration-[var(--dur-micro)]",
          "focus-within:border-ink",
          error ? "border-ink" : "border-line-strong hover:border-ink-2",
        )}
      >
        <input
          id={fieldId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error || hint ? `${fieldId}-note` : undefined}
          className="h-full w-full min-w-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted disabled:opacity-60"
          {...rest}
        />
        {suffix}
      </span>
      {(error || hint) && (
        <span id={`${fieldId}-note`} role={error ? "alert" : undefined} className={cx("mt-1.5 flex gap-1.5 text-sm", error ? "text-ink" : "text-muted")}>
          {error && <i className="ri-error-warning-line" aria-hidden />}
          {error ?? hint}
        </span>
      )}
    </label>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "danger" | "warn"; children: ReactNode }) {
  const tones = {
    neutral: "border-line-strong text-ink-2",
    accent: "border-ink bg-ink text-paper",
    danger: "border-ink text-ink",
    warn: "border-dashed border-ink-2 text-ink",
  };
  return (
    <span className={cx("inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap", tones[tone])}>
      {tone === "danger" && <i className="ri-error-warning-fill" aria-hidden />}
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skeleton block", className)} />;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-control border border-line-strong bg-danger-soft px-4 py-3 text-sm text-ink">
      <span className="flex min-w-0 gap-2">
        <i className="ri-error-warning-line" aria-hidden />
        {message}
      </span>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Meter({ value, max, label, detail, danger }: { value: number; max: number; label: string; detail: string; danger?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  // Black and white: the bar stays white, and turns striped once it nears the limit.
  const warn = danger || pct >= 80;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-ink-2">{label}</span>
        <span className="tabular text-ink">
          {pct >= 100 && <i className="ri-error-warning-fill mr-1" aria-label="limit reached" />}
          {detail}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-well"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cx(
            "h-full origin-left rounded-full bg-ink transition-transform duration-[var(--dur-short)]",
            warn && "bg-[repeating-linear-gradient(135deg,var(--color-ink)_0_4px,var(--color-muted)_4px_7px)]",
          )}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
    </div>
  );
}

export { cx };
