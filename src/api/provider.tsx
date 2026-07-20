/**
 * API context. Holds the configured client and resource APIs so components
 * never construct their own — that keeps the base URL and auth in one place
 * and makes tests trivial (swap the provider, not the modules).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { ApiClient } from './client';
import { QuestionsApi } from './questions';
import { RunsApi } from './runs';

export interface EvalsConfig {
  baseUrl: string;
  authToken?: string;
  /** Library dataset id for this agent. One dataset per agent. */
  datasetId: string;
  /** Library dataset name — Langfuse's run endpoints key on name, not id. */
  datasetName: string;
  /** Agent identifier, used for routing and display only. */
  agentId: string;
  /** Currently saved agent version. Runs target this. See ADR-001. */
  agentVersion: string;
  /** True when the editor has unsaved changes — drives the stale-draft banner. */
  hasUnsavedChanges?: boolean;
}

interface ApiContextValue {
  client: ApiClient;
  questions: QuestionsApi;
  runs: RunsApi;
  config: EvalsConfig;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({
  config,
  children,
  /** Test seam: inject a preconfigured client instead of building one. */
  client: injected,
}: {
  config: EvalsConfig;
  children: ReactNode;
  client?: ApiClient;
}) {
  const value = useMemo<ApiContextValue>(() => {
    const client =
      injected ?? new ApiClient({ baseUrl: config.baseUrl, authToken: config.authToken });
    return {
      client,
      questions: new QuestionsApi(client, config.datasetId),
      runs: new RunsApi(client, config.datasetName),
      config,
    };
  }, [config, injected]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error('useApi must be used inside <ApiProvider>');
  return ctx;
}
