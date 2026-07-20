/**
 * ============================================================================
 * APP ROOT
 * ============================================================================
 *
 * Wires router, query client, API provider and the error boundary.
 *
 * ROUTES:
 *   /agents/:agentId/evals                      Agent home — suite list
 *   /agents/:agentId/evals/library              Question library
 *   /agents/:agentId/evals/suites/new           Create a suite
 *   /agents/:agentId/evals/suites/:suiteName    Edit a suite
 *   /agents/:agentId/evals/runs/:runName        Run results
 *   /agents/:agentId/evals/compare?a=&b=        Compare two runs
 *
 * EMBEDDING: this module owns the BrowserRouter. If you are mounting this
 * inside an existing app that already has a router, import `EvalsRoutes`
 * instead and place it under your own <Routes>. See docs/INTEGRATION.md.
 * ============================================================================
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiProvider, type EvalsConfig } from './api/provider';
import AgentHome from './routes/AgentHome';
import Library from './routes/Library';
import SuiteEditor from './routes/SuiteEditor';
import RunResults from './routes/RunResults';
import Compare from './routes/Compare';
import './styles/tokens.css';
import './styles/app.css';

/**
 * Query defaults.
 *
 * `retry: false` because ApiClient already retries transient failures with
 * backoff. Letting React Query retry on top of that multiplies attempts and
 * makes a dead backend take 9 tries to surface an error.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

/**
 * Catches render-time crashes so a bad row cannot blank the whole page.
 *
 * Deliberately does NOT catch async/query errors — those are handled per-route
 * with retry affordances, which is a better experience than a full-page
 * fallback. This is for genuine programming errors only.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; onError?: (e: Error, info: ErrorInfo) => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    // Replace with your telemetry sink.
    console.error('Evals UI crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="shell">
          <div className="card">
            <div className="empty" role="alert">
              <div
                className="empty-glyph"
                style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
                aria-hidden="true"
              >
                !
              </div>
              <h3>The evals view stopped working</h3>
              <p>
                This is a bug on our side, not something you did. Reloading usually clears it.
              </p>
              <div className="empty-acts">
                <button className="btn btn-primary" onClick={() => window.location.reload()}>
                  Reload
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Route table without a router, for embedding in a host application.
 * Paths are relative to wherever you mount it.
 */
export function EvalsRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AgentHome />} />
      <Route path="/library" element={<Library />} />
      <Route path="/suites/new" element={<SuiteEditor />} />
      <Route path="/suites/:suiteName" element={<SuiteEditor />} />
      <Route path="/runs/:runName" element={<RunResults />} />
      <Route path="/compare" element={<Compare />} />
      {/* Unknown sub-path returns to the home rather than showing a blank. */}
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}

/** Standalone app. Owns its own router. */
export default function App({ config }: { config: EvalsConfig }) {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ApiProvider config={config}>
          <BrowserRouter>
            <Routes>
              <Route
                path={`/agents/${config.agentId}/evals/*`}
                element={<EvalsRoutes />}
              />
              <Route
                path="*"
                element={<Navigate to={`/agents/${config.agentId}/evals`} replace />}
              />
            </Routes>
          </BrowserRouter>
        </ApiProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
