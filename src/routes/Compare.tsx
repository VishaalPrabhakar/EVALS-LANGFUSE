/**
 * ============================================================================
 * COMPARE RUNS  —  /agents/:agentId/evals/compare?a=<run>&b=<run>
 * ============================================================================
 *
 * The point of this screen is the SPLIT: questions whose definition changed
 * between runs are separated from those that didn't, because only the latter
 * produce comparable results.
 *
 * Without the split, a tightened criteria shows up as "your agent regressed"
 * and sends someone debugging a prompt that is fine. See domain/compare.ts
 * and docs/DECISIONS.md ADR-004.
 * ============================================================================
 */

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/provider';
import { useRun, useRuns } from '../hooks/useEvals';
import { compareRuns, type ComparisonRow } from '../domain/compare';
import {
  Banner,
  Card,
  CardHeader,
  ClampText,
  EmptyState,
  ErrorState,
  OutcomePill,
  TableSkeleton,
} from '../components/primitives';

export default function Compare() {
  const { config } = useApi();
  const [params, setParams] = useSearchParams();
  const runsQ = useRuns();

  const aName = params.get('a') ?? '';
  const bName = params.get('b') ?? '';

  const aQ = useRun(aName || undefined);
  const bQ = useRun(bName || undefined);
  const base = `/agents/${config.agentId}/evals`;

  const cmp = useMemo(
    () => (aQ.data && bQ.data ? compareRuns(aQ.data, bQ.data) : null),
    [aQ.data, bQ.data],
  );

  const runs = runsQ.data ?? [];

  // Fewer than two runs means there is nothing to compare. Say that rather
  // than rendering an empty table.
  if (runsQ.isSuccess && runs.length < 2) {
    return (
      <div className="shell">
        <Crumb base={base} />
        <Card>
          <EmptyState
            glyph="⇄"
            title="Nothing to compare yet"
            body="Comparison needs at least two runs. Run your suite again after making a change, then come back."
            actions={
              <Link className="btn btn-primary" to={base}>
                Back to evals
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="shell">
      <Crumb base={base} />

      <div className="head">
        <div>
          <h1>Compare runs</h1>
          <p className="sub">See what changed between two runs — and what isn't comparable.</p>
        </div>
      </div>

      <Card>
        <div className="filters">
          <label className="hint" htmlFor="run-a">
            Earlier
          </label>
          <select
            id="run-a"
            value={aName}
            onChange={(e) => {
              params.set('a', e.target.value);
              setParams(params, { replace: true });
            }}
          >
            <option value="">Choose a run…</option>
            {runs.map((r) => (
              <option key={r.id} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>

          <label className="hint" htmlFor="run-b">
            Later
          </label>
          <select
            id="run-b"
            value={bName}
            onChange={(e) => {
              params.set('b', e.target.value);
              setParams(params, { replace: true });
            }}
          >
            <option value="">Choose a run…</option>
            {runs.map((r) => (
              <option key={r.id} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        {!aName || !bName ? (
          <EmptyState glyph="⇄" title="Pick two runs" body="Choose an earlier and a later run to compare them." />
        ) : aName === bName ? (
          // Comparing a run to itself is a user error worth catching, since
          // the result would be a wall of "unchanged" rows.
          <EmptyState
            glyph="!"
            title="Those are the same run"
            body="Pick two different runs to see what changed between them."
          />
        ) : aQ.isLoading || bQ.isLoading ? (
          <TableSkeleton rows={5} />
        ) : aQ.isError || bQ.isError ? (
          <ErrorState message="One of those runs could not be loaded." retryable onRetry={() => { aQ.refetch(); bQ.refetch(); }} />
        ) : null}
      </Card>

      {cmp ? (
        <>
          {cmp.changed.length > 0 ? (
            <Banner kind="warn">
              <b>
                {cmp.changed.length} {cmp.changed.length === 1 ? 'question' : 'questions'} changed
                between these runs.
              </b>{' '}
              Their results aren't directly comparable — the criteria the agent was scored against
              is different now.
            </Banner>
          ) : null}

          <Card>
            <CardHeader
              title="Summary"
              note={`${cmp.comparable.length} comparable · ${cmp.changed.length} changed`}
            />
            <div className="card-b">
              <div className="legend">
                <span>
                  <b>{cmp.summary.fixed}</b> fixed
                </span>
                <span>
                  <b>{cmp.summary.broke}</b> newly failing
                </span>
                <span>
                  <b>{cmp.summary.stillFailing}</b> still failing
                </span>
                {cmp.summary.unattributable > 0 ? (
                  <span style={{ color: 'var(--warn)' }}>
                    <b>{cmp.summary.unattributable}</b> failing but changed — can't attribute
                  </span>
                ) : null}
              </div>
            </div>
          </Card>

          {cmp.changed.length > 0 ? (
            <Card>
              <CardHeader
                title="Changed since the earlier run"
                note="Not directly comparable"
                actions={<span className="pill pill-warn">{cmp.changed.length}</span>}
              />
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: '26%' }}>Question</th>
                      <th>What changed</th>
                      <th style={{ width: 110 }}>Then</th>
                      <th style={{ width: 110 }}>Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.changed.map((row) => (
                      <Row key={row.questionId} row={row} showNote />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Comparable results"
              note={`${cmp.comparable.length} unchanged ${cmp.comparable.length === 1 ? 'question' : 'questions'}`}
            />
            {cmp.comparable.length === 0 ? (
              <EmptyState
                glyph="!"
                title="Nothing is comparable"
                body="Every question changed between these two runs, so no result can be attributed to the agent itself."
              />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: '26%' }}>Question</th>
                      <th>Suites</th>
                      <th style={{ width: 110 }}>Then</th>
                      <th style={{ width: 110 }}>Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.comparable.map((row) => (
                      <Row key={row.questionId} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Added and removed questions are shown rather than dropped — a
              test that vanished usually means someone archived it, which is
              itself worth knowing. */}
          {cmp.added.length > 0 || cmp.removed.length > 0 ? (
            <Card>
              <CardHeader
                title="Not in both runs"
                note={`${cmp.added.length} added · ${cmp.removed.length} removed`}
              />
              <div className="tbl-wrap">
                <table className="tbl">
                  <tbody>
                    {cmp.added.map((r) => (
                      <tr key={`a-${r.questionId}`}>
                        <td className="cell-name">{r.questionName}</td>
                        <td className="cell-muted">Added since the earlier run</td>
                        <td>{r.after ? <OutcomePill outcome={r.after.outcome} /> : null}</td>
                      </tr>
                    ))}
                    {cmp.removed.map((r) => (
                      <tr key={`r-${r.questionId}`}>
                        <td className="cell-name">{r.questionName}</td>
                        <td className="cell-muted">
                          Not in the later run — archived, or removed from the suite
                        </td>
                        <td>{r.before ? <OutcomePill outcome={r.before.outcome} /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Row({ row, showNote }: { row: ComparisonRow; showNote?: boolean }) {
  return (
    <tr>
      <td className="cell-name">{row.questionName}</td>
      <td className="cell-muted">
        {showNote ? (
          <ClampText text={row.changeNote ?? 'Definition changed'} />
        ) : (
          (row.after?.suites ?? []).join(', ') || '—'
        )}
      </td>
      <td>{row.before ? <OutcomePill outcome={row.before.outcome} /> : <span className="hint">—</span>}</td>
      <td>
        {row.after ? <OutcomePill outcome={row.after.outcome} /> : <span className="hint">—</span>}
        {showNote && row.movement === 'broke' ? (
          <div className="hint" style={{ marginTop: 4 }}>
            May be the criteria change, not a regression
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function Crumb({ base }: { base: string }) {
  return (
    <p className="crumb">
      <Link to={base}>Evals</Link> › Compare
    </p>
  );
}
