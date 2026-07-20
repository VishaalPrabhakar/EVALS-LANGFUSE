/**
 * ============================================================================
 * RUN RESULTS  —  /agents/:agentId/evals/runs/:runName
 * ============================================================================
 *
 * Hierarchy, top to bottom:
 *   1. Score header with delta against the previous run
 *   2. FAILURES, grouped by root cause, expanded by default when few
 *   3. Passing tests, collapsed to one line
 *
 * Nobody opens an eval report to read what passed, so passes collapse. The
 * grouping is what makes a 30-failure run tractable — see domain/grouping.ts,
 * including the confidence floor that disables grouping when clustering is
 * unreliable.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/provider';
import { useRun, useRunProgress, useRuns } from '../hooks/useEvals';
import { groupFailures } from '../domain/grouping';
import { overallStats } from '../domain/rollup';
import { ApiError } from '../api/client';
import {
  Banner,
  Card,
  CardHeader,
  ClampText,
  EmptyState,
  ErrorState,
  OutcomePill,
  ScoreBar,
  TableSkeleton,
} from '../components/primitives';
import { relativeTime } from './AgentHome';
import type { FailureGroup, RunResult } from '../domain/model';

/** Above this many failure groups, collapse them all by default. */
const EXPAND_LIMIT = 5;

export default function RunResults() {
  const { config } = useApi();
  const { runName = '' } = useParams();
  const runQ = useRun(runName);
  const runsQ = useRuns();
  const base = `/agents/${config.agentId}/evals`;

  // Poll only while the run is incomplete. `useRunProgress` stops itself once
  // done === total, so this does not poll forever on a finished run.
  const isIncomplete = runQ.data
    ? runQ.data.results.some((r) => r.outcome === 'running' || r.outcome === 'queued')
    : false;
  const progressQ = useRunProgress(runName, isIncomplete);

  const run = progressQ.data?.run ?? runQ.data;

  const groups = useMemo(() => (run ? groupFailures(run.results) : []), [run]);
  const stats = useMemo(() => (run ? overallStats(run) : null), [run]);

  const previous = useMemo(() => {
    const list = runsQ.data ?? [];
    const idx = list.findIndex((r) => r.name === runName);
    return idx >= 0 && idx + 1 < list.length ? list[idx + 1] : undefined;
  }, [runsQ.data, runName]);

  if (runQ.isLoading) {
    return (
      <div className="shell">
        <Card>
          <TableSkeleton rows={5} />
        </Card>
      </div>
    );
  }

  if (runQ.isError || !run || !stats) {
    const e = runQ.error instanceof ApiError ? runQ.error : undefined;
    return (
      <div className="shell">
        <p className="crumb">
          <Link to={base}>Evals</Link> › Run
        </p>
        <Card>
          <ErrorState
            message={e?.userMessage ?? `Run "${runName}" could not be loaded.`}
            retryable={e?.retryable ?? true}
            onRetry={() => runQ.refetch()}
          />
        </Card>
      </div>
    );
  }

  const passing = run.results.filter((r) => r.outcome === 'passed');
  const errored = run.results.filter((r) => r.outcome === 'error');
  const done = run.results.filter((r) => r.outcome !== 'running' && r.outcome !== 'queued').length;

  // A run with zero results is a real state — the trigger succeeded but the
  // suite was empty, or the backend wrote no items.
  if (run.results.length === 0) {
    return (
      <div className="shell">
        <p className="crumb">
          <Link to={base}>Evals</Link> › {runName}
        </p>
        <Card>
          <EmptyState
            glyph="○"
            title="This run has no results"
            body="The run was created but nothing was executed. The suite may have been empty, or the run may still be starting."
            actions={
              <button className="btn" onClick={() => runQ.refetch()}>
                Check again
              </button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="shell">
      <p className="crumb">
        <Link to={base}>Evals</Link> › Run results
      </p>

      <div className="head">
        <div>
          <h1>Run results</h1>
          <p className="sub">
            {run.suite ?? 'All suites'} ·{' '}
            {run.agentVersion ? `saved version ${run.agentVersion} · ` : ''}
            {relativeTime(run.createdAt)}
          </p>
        </div>
        <div className="head-actions">
          {previous ? (
            <Link
              className="btn btn-sm"
              to={`${base}/compare?a=${encodeURIComponent(previous.name)}&b=${encodeURIComponent(runName)}`}
            >
              Compare to previous
            </Link>
          ) : null}
        </div>
      </div>

      {isIncomplete ? (
        <Banner kind="info">
          Running — {done} of {run.results.length} complete. Results appear as each question
          finishes.
        </Banner>
      ) : null}

      {/* An unreadable score is not a test failure. Say so, so nobody debugs
          a prompt that is fine. */}
      {errored.length > 0 ? (
        <Banner kind="warn">
          <b>{errored.length} {errored.length === 1 ? 'question' : 'questions'} couldn't be scored.</b>{' '}
          These are excluded from the pass rate — they're an evaluation problem, not an agent
          failure.
        </Banner>
      ) : null}

      <Card>
        <div className="score">
          <div className="score-big">
            {stats.inconclusive ? '—' : Math.round(stats.passRate * 100)}
            {stats.inconclusive ? null : <small>%</small>}
          </div>
          <div className="score-bar">
            <ScoreBar passed={stats.passed} failed={stats.failed} errored={stats.errored} />
            <div className="legend">
              <span>
                <span className="swatch" style={{ background: 'var(--ok)' }} />
                <b>{stats.passed}</b> passed
              </span>
              <span>
                <span className="swatch" style={{ background: 'var(--bad)' }} />
                <b>{stats.failed}</b> failed
              </span>
              {stats.errored > 0 ? (
                <span>
                  <span className="swatch" style={{ background: 'var(--ink-3)' }} />
                  <b>{stats.errored}</b> not scored
                </span>
              ) : null}
              <span className="cell-muted">
                {run.results.length} tests
                {run.suite ? ` in ${run.suite}` : ' across all suites'}
              </span>
            </div>
          </div>
        </div>
      </Card>

      {groups.length > 0 ? (
        <Card>
          <CardHeader
            title="What's broken"
            note={`${stats.failed} ${stats.failed === 1 ? 'failure' : 'failures'} · ${groups.length} ${groups.length === 1 ? 'cause' : 'causes'}`}
          />
          {/* Confidence 0 means grouping was refused (see CONFIDENCE_FLOOR).
              Tell the user, rather than presenting singletons as "causes". */}
          {groups.every((g) => g.confidence === 0) && groups.length > 1 ? (
            <div style={{ padding: '10px 16px' }}>
              <span className="hint">
                Showing failures individually — there wasn't enough signal to group them by cause.
              </span>
            </div>
          ) : null}
          {groups.map((g, i) => (
            <FailureGroupRow key={g.id} group={g} defaultOpen={groups.length <= EXPAND_LIMIT && i === 0} />
          ))}
        </Card>
      ) : stats.failed === 0 && !isIncomplete ? (
        <Card>
          <EmptyState
            glyph="✓"
            title="Everything passed"
            body="No failures in this run. Compare against an earlier run to confirm nothing regressed."
          />
        </Card>
      ) : null}

      {passing.length > 0 ? (
        <Card>
          <details>
            <summary className="cause-h" style={{ padding: '13px 16px' }}>
              <span className="caret" aria-hidden="true">▶</span>
              <span className="cause-t grow">
                <b style={{ fontSize: 13.5 }}>
                  {passing.length} passing {passing.length === 1 ? 'test' : 'tests'}
                </b>
              </span>
              <span className="pill pill-pass">All good</span>
            </summary>
            <div style={{ padding: '0 16px 14px 42px' }}>
              {passing.map((r) => (
                <div
                  key={r.questionId}
                  style={{ padding: '8px 0', borderBottom: '1px solid var(--line-2)', fontSize: 13.5 }}
                >
                  {r.questionName}
                </div>
              ))}
            </div>
          </details>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * One root-cause group: the diagnosis, ONE fix action, and the failing tests
 * nested beneath it. The fix is attached to the cause rather than repeated
 * per test — that is the whole point of grouping.
 */
function FailureGroupRow({ group, defaultOpen }: { group: FailureGroup; defaultOpen: boolean }) {
  const [applied, setApplied] = useState(false);

  return (
    <details className="cause" open={defaultOpen}>
      <summary className="cause-h">
        <span className="caret" aria-hidden="true">▶</span>
        <span className="cause-t grow">
          <b>{group.cause}</b>
          <span>
            {group.results.length} {group.results.length === 1 ? 'failure' : 'failures'}
            {group.suites.length ? ` · ${group.suites.join(', ')}` : ''}
          </span>
        </span>
        <span className="pill pill-fail">
          {group.results.length} {group.results.length === 1 ? 'test' : 'tests'}
        </span>
      </summary>

      <div className="cause-b">
        {group.fix ? (
          <div className="fix">
            <h4>
              <span className="pill pill-ai">✦ AI</span> Suggested fix
            </h4>
            <p>{group.fix}</p>
            <div className="fix-acts">
              <button
                className="btn btn-primary btn-sm"
                disabled={applied}
                onClick={() => setApplied(true)}
              >
                {applied ? 'Applied' : 'Apply to system prompt'}
              </button>
              <button className="btn btn-sm">See the change</button>
            </div>
          </div>
        ) : null}

        {group.results.map((r) => (
          <ResultDetail key={r.questionId} result={r} />
        ))}
      </div>
    </details>
  );
}

/** Expected vs actual, side by side. Long answers scroll inside a fixed box. */
function ResultDetail({ result }: { result: RunResult }) {
  return (
    <details className="inst">
      <summary>
        <span className="caret" aria-hidden="true">▶</span>
        <span className="grow" style={{ fontWeight: 550, overflowWrap: 'anywhere' }}>
          {result.questionName}
        </span>
        {result.suites.length ? (
          <span className="pill pill-neutral">{result.suites.join(' · ')}</span>
        ) : null}
        <OutcomePill outcome={result.outcome} />
      </summary>
      <div className="inst-body">
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Asked: <ClampText text={result.prompt} />
        </p>
        <div className="diff">
          <div className="box box-want">
            <h4>A good answer includes</h4>
            <div className="box-bd">{result.criteria || <span className="hint">No criteria set</span>}</div>
          </div>
          <div className="box box-got">
            <h4>Your agent said</h4>
            <div className="box-bd">
              {result.actual || <span className="hint">No answer recorded</span>}
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}
