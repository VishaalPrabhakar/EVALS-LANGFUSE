/**
 * Shared primitives. Deliberately small and unopinionated — these exist to
 * stop every route reinventing a card header or a pass/fail pill, not to be
 * a design system.
 */

import { useState, type ReactNode } from 'react';
import type { Outcome } from '../domain/model';

export function Card({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>;
}

export function CardHeader({
  title,
  note,
  actions,
}: {
  title: string;
  note?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="card-h">
      <h2>
        {title} {note ? <span className="card-note">{note}</span> : null}
      </h2>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </div>
  );
}

/** Outcome pill. 'error' is visually distinct from 'failed' on purpose —
 *  an uninterpretable score is not the same as a wrong answer. */
export function OutcomePill({ outcome }: { outcome: Outcome }) {
  switch (outcome) {
    case 'passed':
      return <span className="pill pill-pass">Passed</span>;
    case 'failed':
      return <span className="pill pill-fail">Failed</span>;
    case 'error':
      return (
        <span className="pill pill-warn" title="The score could not be read — this is not a test failure">
          Not scored
        </span>
      );
    case 'running':
      return <span className="pill pill-neutral">Running…</span>;
    default:
      return <span className="pill pill-neutral">Queued</span>;
  }
}

/**
 * Two-line clamp with an inline expand.
 *
 * Clamps to two lines rather than one: a single line truncates most real
 * questions mid-clause, forcing expansion to read anything and defeating the
 * scan. Two lines carries enough to identify a test.
 */
export function ClampText({ text, expandable = true }: { text: string; expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  // Rough threshold — cheaper and more stable than measuring layout.
  const isLong = text.length > 90;
  return (
    <>
      <span className={open ? 'clamp clamp-open' : 'clamp'}>{text}</span>
      {expandable && isLong ? (
        <button className="more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}

export function Banner({
  kind,
  children,
  action,
}: {
  kind: 'warn' | 'error' | 'info';
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{kind === 'info' ? 'ℹ' : '⚠'}</span>
      <span className="grow">{children}</span>
      {action}
    </div>
  );
}

export function EmptyState({
  glyph,
  title,
  body,
  actions,
}: {
  glyph: string;
  title: string;
  body: string;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-glyph" aria-hidden="true">
        {glyph}
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      {actions ? <div className="empty-acts">{actions}</div> : null}
    </div>
  );
}

/** Table-shaped loading skeleton. Matches row height to avoid layout shift. */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" style={{ padding: '12px 0' }}>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel skel-row" style={{ width: `${88 - (i % 3) * 12}%` }} />
      ))}
    </div>
  );
}

/**
 * Error state with a retry affordance when the failure is retryable.
 * Non-retryable errors omit the button rather than offering a dead action.
 */
export function ErrorState({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="empty" role="alert">
      <div className="empty-glyph" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }} aria-hidden="true">
        !
      </div>
      <h3>Something went wrong</h3>
      <p>{message}</p>
      {retryable && onRetry ? (
        <div className="empty-acts">
          <button className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Pass/fail/error bar used in the score header. */
export function ScoreBar({ passed, failed, errored = 0 }: { passed: number; failed: number; errored?: number }) {
  const total = passed + failed + errored;
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return (
    <div className="track" role="img" aria-label={`${passed} passed, ${failed} failed${errored ? `, ${errored} not scored` : ''}`}>
      <i className="p" style={{ width: `${pct(passed)}%` }} />
      <i className="f" style={{ width: `${pct(failed)}%` }} />
      <i className="e" style={{ width: `${pct(errored)}%` }} />
    </div>
  );
}
