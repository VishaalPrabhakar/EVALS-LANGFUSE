/**
 * ============================================================================
 * AGENT HOME  —  /agents/:agentId/evals
 * ============================================================================
 *
 * Lists SUITES, never questions. This is the single most important structural
 * decision in the UI: because a suite list is bounded (a handful of rows) and
 * a question list is not, nothing here grows with the library. The question
 * library is one level down, reached from the header.
 *
 * Replaces the original three-tab layout (Overview / Run Results / Test
 * Questions), where every tab could be empty and each empty state pointed at
 * a different tab. See docs/DECISIONS.md ADR-007.
 * ============================================================================
 */

import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../api/provider';
import { useQuestions, useRuns, useSuites, useTriggerRun } from '../hooks/useEvals';
import { orphanQuestions } from '../domain/library';
import { ApiError } from '../api/client';
import {
  Banner,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  TableSkeleton,
} from '../components/primitives';

export default function AgentHome() {
  const { config } = useApi();
  const navigate = useNavigate();
  const suitesQ = useSuites();
  const questionsQ = useQuestions();
  const runsQ = useRuns();
  const trigger = useTriggerRun();

  const base = `/agents/${config.agentId}/evals`;

  if (questionsQ.isLoading) {
    return (
      <div className="shell">
        <Header agentId={config.agentId} />
        <Card>
          <TableSkeleton rows={3} />
        </Card>
      </div>
    );
  }

  if (questionsQ.isError) {
    const err = questionsQ.error;
    const apiErr = err instanceof ApiError ? err : undefined;
    return (
      <div className="shell">
        <Header agentId={config.agentId} />
        <Card>
          <ErrorState
            message={apiErr?.userMessage ?? 'Could not load your evals.'}
            retryable={apiErr?.retryable ?? true}
            onRetry={() => questionsQ.refetch()}
          />
        </Card>
      </div>
    );
  }

  const questions = questionsQ.data ?? [];
  const suites = suitesQ.data ?? [];
  const orphans = orphanQuestions(questions);

  // First-run: nothing written at all. ONE empty state, ONE action. The
  // original design had three competing empty states here.
  if (questions.length === 0) {
    return (
      <div className="shell">
        <Header agentId={config.agentId} />
        <Card>
          <EmptyState
            glyph="✎"
            title="Write your first test question"
            body="A test question is something a real user would ask, plus what a good answer must include. Run them any time to catch regressions before you deploy."
            actions={
              <>
                <Link className="btn btn-primary" to={`${base}/library?new=ai`}>
                  Generate questions with AI
                </Link>
                <Link className="btn" to={`${base}/library?new=1`}>
                  Write one myself
                </Link>
              </>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="shell">
      <Header
        agentId={config.agentId}
        actions={
          <>
            <Link className="btn btn-sm" to={`${base}/library`}>
              Question library
            </Link>
            <button
              className="btn btn-primary btn-sm"
              disabled={suites.length === 0 || trigger.isPending}
              onClick={async () => {
                const res = await trigger.mutateAsync({});
                navigate(`${base}/runs/${encodeURIComponent(res.runName)}`);
              }}
            >
              {trigger.isPending ? 'Starting…' : 'Run all suites'}
            </button>
          </>
        }
      />

      {/* ADR-001: runs target the SAVED agent. Warn when the draft is ahead,
          otherwise users test a version they aren't looking at. */}
      {config.hasUnsavedChanges ? (
        <Banner kind="warn">
          You have unsaved changes. <b>Tests run against the last saved version</b> — save first
          to test your edits.
        </Banner>
      ) : null}

      {trigger.isError ? (
        <Banner kind="error">
          {trigger.error instanceof ApiError
            ? trigger.error.userMessage
            : 'Could not start the run.'}
        </Banner>
      ) : null}

      <div className="cols">
        <div>
          <Card>
            <CardHeader
              title="Suites"
              note={`${suites.length} ${suites.length === 1 ? 'suite' : 'suites'} · ${questions.length} questions in library`}
              actions={
                <Link className="btn btn-sm" to={`${base}/suites/new`}>
                  New suite
                </Link>
              }
            />

            {suites.length === 0 ? (
              <EmptyState
                glyph="◫"
                title="Group your questions into a suite"
                body="A suite is a named selection of questions you run together — a quick smoke suite for every save, a fuller one before deploy."
                actions={
                  <Link className="btn btn-primary" to={`${base}/suites/new`}>
                    Create a suite
                  </Link>
                }
              />
            ) : (
              suites.map((s) => {
                const lr = s.lastRun;
                const total = lr ? lr.passed + lr.failed : 0;
                const pct = total ? Math.round((lr!.passed / total) * 100) : null;
                return (
                  <button
                    key={s.name}
                    className="suite-row"
                    onClick={() => navigate(`${base}/suites/${encodeURIComponent(s.name)}`)}
                  >
                    <span className="grow">
                      <span className="suite-name">{s.name}</span>
                      <span className="suite-meta">
                        {s.questionCount} {s.questionCount === 1 ? 'question' : 'questions'}
                        {lr ? ` · ran ${relativeTime(lr.at)}` : ' · never run'}
                      </span>
                    </span>

                    {pct !== null ? (
                      <span className="rate">
                        <span className="mini">
                          <i className="p" style={{ width: `${pct}%` }} />
                          <i className="f" style={{ width: `${100 - pct}%` }} />
                        </span>
                        <span style={{ color: lr!.failed ? 'var(--bad)' : 'var(--ok)' }}>
                          {pct}%
                        </span>
                      </span>
                    ) : (
                      <span className="hint">Never run</span>
                    )}

                    {/* An empty suite is a real state — it renders as a
                        distinct warning rather than a misleading 0%. */}
                    {s.questionCount === 0 ? (
                      <span className="pill pill-warn">Empty</span>
                    ) : lr && lr.failed ? (
                      <span className="pill pill-fail">{lr.failed} failing</span>
                    ) : lr ? (
                      <span className="pill pill-pass">All passing</span>
                    ) : (
                      <span className="pill pill-neutral">Not run</span>
                    )}
                  </button>
                );
              })
            )}
          </Card>

          {runsQ.data && runsQ.data.length > 0 ? (
            <Card>
              <CardHeader title="Recent runs" />
              {runsQ.data.slice(0, 5).map((r) => (
                <Link
                  key={r.id}
                  className="suite-row"
                  to={`${base}/runs/${encodeURIComponent(r.name)}`}
                  style={{ textDecoration: 'none', color: 'inherit', display: 'flex' }}
                >
                  <span className="grow">
                    <span className="suite-name">{r.suite ?? 'All suites'}</span>
                    <span className="suite-meta">
                      {relativeTime(r.createdAt)}
                      {r.agentVersion ? ` · ${r.agentVersion}` : ''}
                    </span>
                  </span>
                </Link>
              ))}
            </Card>
          ) : null}
        </div>

        <Card>
          <CardHeader
            title="Coverage gaps"
            actions={
              orphans.length ? <span className="pill pill-warn">{orphans.length}</span> : undefined
            }
          />
          <div className="card-b">
            {orphans.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                Every question is in at least one suite.
              </p>
            ) : (
              <ul className="cov">
                {/* The orphan state is new under the library model and is
                    silent unless surfaced: a question can exist, look correct
                    in the table, and never run. */}
                {orphans.slice(0, 5).map((q) => (
                  <li key={q.id}>
                    <span className="risk risk-hi" />
                    <span className="txt">
                      {q.name}
                      <small>Not in any suite — this never runs</small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link
              className="btn btn-sm"
              to={`${base}/library?filter=orphans`}
              style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
            >
              Review in library
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Header({ agentId, actions }: { agentId: string; actions?: React.ReactNode }) {
  return (
    <div className="head">
      <div>
        <h1>Evals</h1>
        <p className="sub">
          Check your agent still answers correctly before you deploy.{' '}
          <span className="sr-only">Agent {agentId}</span>
        </p>
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * Relative time without a date library.
 * Falls back to a locale date past a week, because "23 days ago" is less
 * useful than the actual date at that range.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diff = Date.now() - then;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d <= 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
