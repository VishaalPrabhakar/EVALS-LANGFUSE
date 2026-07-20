/**
 * ============================================================================
 * QUESTION LIBRARY  —  /agents/:agentId/evals/library
 * ============================================================================
 *
 * The single home for question content. Every question exists here exactly
 * once; suites reference them. The "Used in" column is the disclosure that
 * makes shared editing safe — you can see a change will land in three suites
 * before you make it.
 *
 * Cap is enforced and displayed here because this is where questions are
 * created. See docs/DECISIONS.md ADR-005.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/provider';
import { useArchiveQuestion, useQuestions, useRestoreQuestion } from '../hooks/useEvals';
import { QUESTION_CAP, capState, deriveSuites, suitesAffectedByArchive } from '../domain/library';
import { ApiError } from '../api/client';
import {
  Banner,
  Card,
  ClampText,
  EmptyState,
  ErrorState,
  TableSkeleton,
} from '../components/primitives';

/** Library filter modes. `orphans` is linked to from the coverage panel. */
type FilterMode = 'all' | 'orphans' | 'archived';

export default function Library() {
  const { config } = useApi();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [suiteFilter, setSuiteFilter] = useState('');
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  const mode = (params.get('filter') as FilterMode) ?? 'all';
  const includeArchived = mode === 'archived';

  const questionsQ = useQuestions(includeArchived);
  const archive = useArchiveQuestion();
  const restore = useRestoreQuestion();

  const base = `/agents/${config.agentId}/evals`;
  const all = questionsQ.data ?? [];

  const suiteNames = useMemo(
    () => deriveSuites(all.filter((q) => !q.archived)).map((s) => s.name),
    [all],
  );

  /**
   * Filtering is client-side. Safe because the cap bounds the set at 100 —
   * if the cap is ever raised past ~1000, move this server-side.
   */
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return all.filter((q) => {
      if (mode === 'orphans' && (q.suites.length > 0 || q.archived)) return false;
      if (mode === 'archived' && !q.archived) return false;
      if (mode === 'all' && q.archived) return false;
      if (suiteFilter && !q.suites.includes(suiteFilter)) return false;
      if (!term) return true;
      return (
        q.name.toLowerCase().includes(term) ||
        q.prompt.toLowerCase().includes(term) ||
        q.criteria.toLowerCase().includes(term)
      );
    });
  }, [all, mode, search, suiteFilter]);

  const activeCount = all.filter((q) => !q.archived).length;
  const cap = capState(activeCount);

  if (questionsQ.isLoading) {
    return (
      <div className="shell">
        <Crumb base={base} />
        <Card>
          <TableSkeleton rows={6} />
        </Card>
      </div>
    );
  }

  if (questionsQ.isError) {
    const e = questionsQ.error instanceof ApiError ? questionsQ.error : undefined;
    return (
      <div className="shell">
        <Crumb base={base} />
        <Card>
          <ErrorState
            message={e?.userMessage ?? 'Could not load the question library.'}
            retryable={e?.retryable ?? true}
            onRetry={() => questionsQ.refetch()}
          />
        </Card>
      </div>
    );
  }

  const pending = confirmArchive ? suitesAffectedByArchive(all, confirmArchive) : [];

  return (
    <div className="shell">
      <Crumb base={base} />
      <div className="head">
        <div>
          <h1>Question library</h1>
          <p className="sub">
            Every question for this agent. Suites select from here — a question is stored once.
          </p>
        </div>
        <div className="head-actions">
          <Link className="btn btn-sm" to={`${base}/library?new=ai`}>
            <span className="pill pill-ai">✦ AI</span> Generate
          </Link>
          <Link
            className="btn btn-primary btn-sm"
            to={`${base}/library?new=1`}
            // At the cap, the create action is disabled with an explanation
            // rather than silently failing on submit.
            aria-disabled={cap.atCap}
            onClick={(e) => cap.atCap && e.preventDefault()}
            style={cap.atCap ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
          >
            Add question
          </Link>
        </div>
      </div>

      {/* Caps that explain themselves read as a design decision. Caps that
          just block read as a bug. */}
      {cap.atCap ? (
        <Banner kind="warn">
          <b>You've reached the {QUESTION_CAP}-question limit.</b> Suites are capped to keep runs
          fast. Archive questions you no longer use to make room.
        </Banner>
      ) : null}

      {archive.isError || restore.isError ? (
        <Banner kind="error">
          {(archive.error ?? restore.error) instanceof ApiError
            ? ((archive.error ?? restore.error) as ApiError).userMessage
            : 'That change could not be saved.'}
        </Banner>
      ) : null}

      <Card>
        <div className="filters">
          <input
            placeholder="Search questions…"
            aria-label="Search questions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="Filter by suite"
            value={suiteFilter}
            onChange={(e) => setSuiteFilter(e.target.value)}
          >
            <option value="">All suites</option>
            {suiteNames.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by state"
            value={mode}
            onChange={(e) => {
              const v = e.target.value as FilterMode;
              if (v === 'all') params.delete('filter');
              else params.set('filter', v);
              setParams(params, { replace: true });
            }}
          >
            <option value="all">Active questions</option>
            <option value="orphans">Not in any suite</option>
            <option value="archived">Archived</option>
          </select>
          <span className="grow" />
          <span
            className={`cap-counter ${cap.atCap ? 'cap-at' : cap.near ? 'cap-near' : ''}`}
            aria-live="polite"
          >
            <b>{activeCount}</b> / {QUESTION_CAP} questions
          </span>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            glyph={mode === 'orphans' ? '✓' : '⌕'}
            title={emptyTitle(mode, Boolean(search || suiteFilter))}
            body={emptyBody(mode, Boolean(search || suiteFilter))}
            actions={
              search || suiteFilter ? (
                <button
                  className="btn"
                  onClick={() => {
                    setSearch('');
                    setSuiteFilter('');
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '20%' }}>Name</th>
                  <th style={{ width: '30%' }}>Question</th>
                  <th>A good answer includes</th>
                  <th style={{ width: 130 }}>Used in</th>
                  <th style={{ width: 90 }}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((q) => (
                  <tr key={q.id}>
                    <td className="cell-name">
                      <ClampText text={q.name} expandable={false} />
                    </td>
                    <td>
                      <ClampText text={q.prompt} />
                    </td>
                    <td className="cell-muted">
                      {/* Empty criteria is a legitimate state the AI generator
                          produces — render an explicit marker, not a blank. */}
                      {q.criteria ? (
                        <ClampText text={q.criteria} />
                      ) : (
                        <span className="hint">No criteria set</span>
                      )}
                    </td>
                    <td>
                      {q.suites.length ? (
                        <span className="used-in" title={q.suites.join(', ')}>
                          {q.suites.length} {q.suites.length > 1 ? 'suites' : 'suite'}
                        </span>
                      ) : (
                        <span
                          className="used-in used-in-zero"
                          title="Not in any suite — this question never runs"
                        >
                          Not in a suite
                        </span>
                      )}
                    </td>
                    <td>
                      {q.archived ? (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => restore.mutate(q.id)}
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setConfirmArchive(q.id)}
                        >
                          Archive
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="hint" style={{ marginTop: 12 }}>
        Editing a question changes it everywhere it's used. The <b>Used in</b> column shows where
        before you edit.
      </p>

      {/* Archiving the last test in a suite silently drops that suite's
          coverage. The confirmation says so explicitly. */}
      {confirmArchive ? (
        <ConfirmArchive
          affected={pending}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={() => {
            archive.mutate(confirmArchive);
            setConfirmArchive(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ConfirmArchive({
  affected,
  onCancel,
  onConfirm,
}: {
  affected: Array<{ suite: string; remaining: number }>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const emptied = affected.filter((a) => a.remaining === 0);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="archive-title"
      style={overlay}
      onClick={onCancel}
    >
      <div className="card" style={dialog} onClick={(e) => e.stopPropagation()}>
        <div className="card-b">
          <h3 id="archive-title" style={{ margin: '0 0 8px', fontSize: 16 }}>
            Archive this question?
          </h3>
          <p style={{ fontSize: 13.5, color: 'var(--ink-2)', marginTop: 0 }}>
            It stops running and disappears from suites, but stays readable in past runs. You can
            restore it any time.
          </p>

          {emptied.length ? (
            <Banner kind="warn">
              This is the last question in{' '}
              <b>{emptied.map((e) => e.suite).join(', ')}</b>. That suite will have nothing to run.
            </Banner>
          ) : null}

          <div className="fix-acts" style={{ marginTop: 14 }}>
            <button className="btn btn-danger" onClick={onConfirm}>
              Archive
            </button>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(18,33,28,.4)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 100,
  padding: 20,
};
const dialog: React.CSSProperties = { maxWidth: 440, width: '100%' };

function Crumb({ base }: { base: string }) {
  return (
    <p className="crumb">
      <Link to={base}>Evals</Link> › Question library
    </p>
  );
}

function emptyTitle(mode: FilterMode, filtered: boolean): string {
  if (filtered) return 'No questions match';
  if (mode === 'orphans') return 'Every question is in a suite';
  if (mode === 'archived') return 'Nothing archived';
  return 'No questions yet';
}

function emptyBody(mode: FilterMode, filtered: boolean): string {
  if (filtered) return 'Try a different search term, or clear the filters to see everything.';
  if (mode === 'orphans')
    return 'Nothing is sitting unused — every question belongs to at least one suite and will run.';
  if (mode === 'archived')
    return 'Archived questions stop running but stay readable in past runs. None here yet.';
  return 'Add a question to get started.';
}
