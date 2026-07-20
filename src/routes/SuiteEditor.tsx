/**
 * ============================================================================
 * SUITE EDITOR  —  /agents/:agentId/evals/suites/:suiteName
 * ============================================================================
 *
 * A suite is a SELECTION, so editing one is a checkbox list over the library.
 * There is deliberately no "copy question into this suite" affordance — its
 * absence is what makes drift structurally impossible.
 *
 * Membership is saved as a bulk metadata write. That write is NOT atomic, so
 * partial failure is handled explicitly and reported per-question. Silent
 * partial success would leave the user unable to tell what their suite
 * actually contains.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../api/provider';
import {
  useDeleteSuite,
  useQuestions,
  useSaveSuiteMembership,
  useTriggerRun,
} from '../hooks/useEvals';
import { toggleMembership } from '../domain/library';
import { ApiError } from '../api/client';
import {
  Banner,
  Card,
  ClampText,
  EmptyState,
  ErrorState,
  TableSkeleton,
} from '../components/primitives';

export default function SuiteEditor() {
  const { config } = useApi();
  const { suiteName = '' } = useParams();
  const navigate = useNavigate();
  const questionsQ = useQuestions();
  const save = useSaveSuiteMembership();
  const del = useDeleteSuite();
  const trigger = useTriggerRun();

  const base = `/agents/${config.agentId}/evals`;
  const isNew = suiteName === 'new';
  const [name, setName] = useState(isNew ? '' : suiteName);
  const [search, setSearch] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const all = useMemo(() => questionsQ.data ?? [], [questionsQ.data]);

  /**
   * Local selection state, seeded from current membership.
   * Held locally rather than written per-click so the user can make several
   * changes and save once — a per-click write would be N round trips and
   * would leave the suite half-edited if they navigated away.
   */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const effective = useMemo(() => {
    if (selected) return selected;
    return new Set(all.filter((q) => q.suites.includes(suiteName)).map((q) => q.id));
  }, [selected, all, suiteName]);

  const visible = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!t) return all;
    return all.filter(
      (q) => q.name.toLowerCase().includes(t) || q.prompt.toLowerCase().includes(t),
    );
  }, [all, search]);

  if (questionsQ.isLoading) {
    return (
      <div className="shell">
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
        <Card>
          <ErrorState
            message={e?.userMessage ?? 'Could not load questions.'}
            retryable
            onRetry={() => questionsQ.refetch()}
          />
        </Card>
      </div>
    );
  }

  // A suite whose questions were all archived still exists but has nothing to
  // run. Distinguish that from "suite does not exist".
  const suiteExists = isNew || all.some((q) => q.suites.includes(suiteName));

  const targetName = isNew ? name.trim() : suiteName;
  const canSave = targetName.length > 0 && (selected !== null || isNew);

  async function handleSave() {
    if (!targetName) return;
    // Compute the minimal write set: only questions whose membership changed.
    const updates = all
      .filter((q) => {
        const was = q.suites.includes(targetName);
        const now = effective.has(q.id);
        return was !== now;
      })
      .map((q) => ({
        id: q.id,
        suites: toggleMembership(q.suites, targetName, effective.has(q.id)),
      }));

    if (updates.length === 0) {
      navigate(base);
      return;
    }

    setProgress({ done: 0, total: updates.length });
    const res = await save.mutateAsync({
      updates,
      suiteName: targetName,
      onProgress: (done, total) => setProgress({ done, total }),
    });
    setProgress(null);
    // Only navigate on full success — a partial failure must stay on screen
    // so the user can see and retry the remainder.
    if (res.failed.length === 0) navigate(base);
  }

  const failed = save.data?.failed ?? [];

  return (
    <div className="shell">
      <p className="crumb">
        <Link to={base}>Evals</Link> › {isNew ? 'New suite' : suiteName}
      </p>

      <div className="head">
        <div>
          {isNew ? (
            <input
              className="filters"
              style={{ fontSize: 18, fontWeight: 600, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
              placeholder="Suite name, e.g. Smoke"
              aria-label="Suite name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          ) : (
            <h1>{suiteName}</h1>
          )}
          <p className="sub">Pick which questions this suite includes.</p>
        </div>
        <div className="head-actions">
          {!isNew && suiteExists ? (
            <button
              className="btn btn-sm"
              disabled={trigger.isPending || effective.size === 0}
              onClick={async () => {
                const res = await trigger.mutateAsync({ suite: suiteName });
                navigate(`${base}/runs/${encodeURIComponent(res.runName)}`);
              }}
            >
              Run suite
            </button>
          ) : null}
          <button className="btn btn-primary btn-sm" disabled={!canSave || save.isPending} onClick={handleSave}>
            {save.isPending ? 'Saving…' : 'Save suite'}
          </button>
        </div>
      </div>

      {!suiteExists && !isNew ? (
        <Banner kind="warn">
          <b>This suite has no questions.</b> It may have been emptied, or every question in it was
          archived. Tick questions below to rebuild it.
        </Banner>
      ) : null}

      {failed.length > 0 ? (
        <Banner
          kind="error"
          action={
            <button className="btn btn-sm" onClick={handleSave}>
              Retry {failed.length}
            </button>
          }
        >
          <b>{failed.length} of {(save.data?.ok.length ?? 0) + failed.length} changes didn't save.</b>{' '}
          The suite is partially updated. Retry to finish.
        </Banner>
      ) : null}

      {progress ? (
        <Banner kind="info">
          Saving… {progress.done} of {progress.total}
        </Banner>
      ) : null}

      <Card>
        <div className="selbar">
          <span>
            ✓ {effective.size} of {all.length} questions selected
          </span>
          <span className="grow" />
          <span className="cap-counter" style={{ color: 'inherit' }}>
            {effective.size} per run
          </span>
        </div>

        <div className="filters">
          <input
            placeholder="Search questions…"
            aria-label="Search questions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="grow" />
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setSelected(new Set(visible.map((q) => q.id)))}
          >
            Select all shown
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>

        {all.length === 0 ? (
          <EmptyState
            glyph="✎"
            title="No questions to select"
            body="Write questions in the library first, then come back to group them into a suite."
            actions={
              <Link className="btn btn-primary" to={`${base}/library?new=1`}>
                Go to library
              </Link>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            glyph="⌕"
            title="No questions match"
            body="Try a different search term."
            actions={
              <button className="btn" onClick={() => setSearch('')}>
                Clear search
              </button>
            }
          />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <span className="sr-only">Include</span>
                  </th>
                  <th style={{ width: '22%' }}>Name</th>
                  <th style={{ width: '34%' }}>Question</th>
                  <th>A good answer includes</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={effective.has(q.id)}
                        aria-label={`Include ${q.name}`}
                        onChange={(e) => {
                          const next = new Set(effective);
                          if (e.target.checked) next.add(q.id);
                          else next.delete(q.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="cell-name">
                      <ClampText text={q.name} expandable={false} />
                    </td>
                    <td>
                      <ClampText text={q.prompt} />
                    </td>
                    <td className="cell-muted">
                      <ClampText text={q.criteria || '—'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="hint" style={{ marginTop: 12 }}>
        Unticking removes the question from this suite. It stays in the library and in any other
        suite that uses it.
      </p>

      {!isNew && suiteExists ? (
        <div style={{ marginTop: 20 }}>
          <button
            className="btn btn-sm btn-ghost"
            style={{ color: 'var(--bad)' }}
            disabled={del.isPending}
            onClick={async () => {
              const res = await del.mutateAsync(suiteName);
              if (res.failed.length === 0) navigate(base);
            }}
          >
            Delete suite
          </button>
          <span className="hint" style={{ marginLeft: 8 }}>
            Questions stay in the library.
          </span>
        </div>
      ) : null}
    </div>
  );
}
