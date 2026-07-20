/**
 * ============================================================================
 * DATA HOOKS
 * ============================================================================
 *
 * React Query wrappers around the API layer. Business rules that need the
 * current cache live here — most importantly the 100-question cap, which
 * cannot be enforced in the API module because it needs the current count.
 * ============================================================================
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/provider';
import type { QuestionDraft } from '../api/questions';
import {
  QUESTION_CAP,
  capState,
  deriveSuites,
  planDeleteSuite,
  planRename,
} from '../domain/library';
import { withLastRun } from '../domain/rollup';
import type { Question, Run } from '../domain/model';

/** Query keys, centralised so invalidation cannot drift from fetching. */
export const qk = {
  questions: (includeArchived: boolean) => ['questions', includeArchived] as const,
  runs: () => ['runs'] as const,
  run: (name: string) => ['run', name] as const,
};

/** Load the question library. */
export function useQuestions(includeArchived = false) {
  const { questions } = useApi();
  return useQuery({
    queryKey: qk.questions(includeArchived),
    queryFn: () => questions.list(includeArchived),
    staleTime: 30_000,
  });
}

/**
 * Derived suites, with last-run numbers attached.
 *
 * `knownSuites` comes from localStorage so a suite emptied of all questions
 * does not silently disappear. See docs/EDGE_CASES.md #4.
 */
export function useSuites() {
  const questionsQ = useQuestions();
  const runsQ = useRuns();
  const latestRun = useRun(runsQ.data?.[0]?.name);

  const known = readKnownSuites();
  const suites = deriveSuites(questionsQ.data ?? [], known);

  return {
    ...questionsQ,
    data: withLastRun(suites, latestRun.data),
  };
}

/** Persisted suite names, so empty suites survive. */
const KNOWN_KEY = 'evals.knownSuites';

export function readKnownSuites(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // Private browsing, quota, or corrupt value. Degrade to no known suites
    // rather than crashing the agent home screen.
    return [];
  }
}

export function rememberSuite(name: string): void {
  try {
    const cur = new Set(readKnownSuites());
    cur.add(name);
    localStorage.setItem(KNOWN_KEY, JSON.stringify([...cur]));
  } catch {
    /* non-fatal */
  }
}

export function forgetSuite(name: string): void {
  try {
    const cur = readKnownSuites().filter((s) => s !== name);
    localStorage.setItem(KNOWN_KEY, JSON.stringify(cur));
  } catch {
    /* non-fatal */
  }
}

/** Thrown when a create would exceed the cap. Carries a user-facing message. */
export class CapExceededError extends Error {
  constructor() {
    super(
      `You've reached the ${QUESTION_CAP}-question limit. Archive questions you no longer use, or remove some from this agent.`,
    );
    this.name = 'CapExceededError';
  }
}

/**
 * Create a question, enforcing the cap.
 *
 * The cap check reads the CURRENT cache rather than refetching. That means a
 * second tab could push the count over between check and write. The backend
 * should enforce the real limit; this check exists to give a good message
 * before a wasted round trip, not as the source of truth.
 */
export function useCreateQuestion() {
  const { questions } = useApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (draft: QuestionDraft) => {
      const current = qc.getQueryData<Question[]>(qk.questions(false)) ?? [];
      if (capState(current.length).atCap) throw new CapExceededError();
      const created = await questions.create(draft);
      draft.suites?.forEach(rememberSuite);
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['questions'] });
    },
  });
}

export function useUpdateQuestion() {
  const { questions } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: QuestionDraft }) =>
      questions.update(id, draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questions'] }),
  });
}

export function useArchiveQuestion() {
  const { questions } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => questions.archive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questions'] }),
  });
}

export function useRestoreQuestion() {
  const { questions } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => questions.restore(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questions'] }),
  });
}

/**
 * Save suite membership from the suite editor.
 *
 * Reports partial failure. If 3 of 40 writes fail the user must know WHICH,
 * or they cannot tell whether their suite is correct. Silent partial success
 * is the worst outcome here.
 */
export function useSaveSuiteMembership() {
  const { questions } = useApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: {
      updates: Array<{ id: string; suites: string[] }>;
      suiteName: string;
      onProgress?: (done: number, total: number) => void;
    }) => {
      const res = await questions.setSuiteMembershipBulk(args.updates, args.onProgress);
      rememberSuite(args.suiteName);
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questions'] }),
  });
}

/**
 * Rename a suite across every member question.
 *
 * NOT ATOMIC — see library.ts::planRename. On partial failure the UI will
 * briefly show both names. The mutation returns the failure list so the
 * caller can offer a targeted retry.
 */
export function useRenameSuite() {
  const { questions } = useApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ from, to }: { from: string; to: string }) => {
      const all = qc.getQueryData<Question[]>(qk.questions(false)) ?? [];
      const updates = planRename(all, from, to);
      const res = await questions.setSuiteMembershipBulk(updates);
      if (res.failed.length === 0) {
        forgetSuite(from);
        rememberSuite(to);
      }
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questions'] }),
  });
}

/** Delete a suite. Removes membership only — never deletes questions. */
export function useDeleteSuite() {
  const { questions } = useApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (suite: string) => {
      const all = qc.getQueryData<Question[]>(qk.questions(false)) ?? [];
      const res = await questions.setSuiteMembershipBulk(planDeleteSuite(all, suite));
      if (res.failed.length === 0) forgetSuite(suite);
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['questions'] }),
  });
}

/** List runs, newest first. */
export function useRuns() {
  const { runs } = useApi();
  return useQuery({ queryKey: qk.runs(), queryFn: () => runs.list(), staleTime: 15_000 });
}

/**
 * Load one run's full results.
 *
 * Depends on the library being loaded — results are assembled by joining run
 * items against cached questions (see runs.ts). `enabled` gates on both.
 */
export function useRun(runName: string | undefined) {
  const { runs } = useApi();
  const library = useQuestions(true);

  return useQuery<Run>({
    queryKey: qk.run(runName ?? ''),
    queryFn: () => runs.getRunResults(runName as string, library.data ?? []),
    enabled: Boolean(runName) && library.isSuccess,
    staleTime: 60_000,
  });
}

/**
 * Poll an in-flight run.
 *
 * Polls every 3s while running, stops on completion. Long-poll or SSE would
 * be better; polling is used because it needs nothing from the backend.
 */
export function useRunProgress(runName: string | undefined, enabled: boolean) {
  const { runs } = useApi();
  const library = useQuestions(true);

  return useQuery({
    queryKey: ['run-progress', runName],
    queryFn: () => runs.getProgress(runName as string, library.data ?? []),
    enabled: Boolean(runName) && enabled && library.isSuccess,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 3000;
      return data.done >= data.total ? false : 3000;
    },
  });
}

/** Trigger a run against the SAVED agent version. See ADR-001. */
export function useTriggerRun() {
  const { runs, config } = useApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (args: { suite?: string; questionIds?: string[] }) =>
      runs.trigger({ ...args, agentVersion: config.agentVersion }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.runs() }),
  });
}
