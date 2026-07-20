/**
 * ============================================================================
 * CONFIGURATION LOADING & VALIDATION
 * ============================================================================
 *
 * WHY THIS EXISTS: without validation, a missing VITE_DATASET_ID fails at
 * runtime deep inside a network call, producing an error that looks like a
 * backend problem. Validating at startup turns that into a readable message
 * naming exactly what is missing.
 *
 * Call `loadConfig()` once in `main.tsx`. Do not read `import.meta.env`
 * anywhere else — scattered env access is how a variable ends up required in
 * production but absent from the deploy manifest.
 *
 * 📖 docs/PRODUCTION_READINESS.md item 5
 * ============================================================================
 */

import type { EvalsConfig } from './api/provider';

/** Thrown at startup when configuration is missing or malformed. */
export class ConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[], detail?: string) {
    const lines = [
      'Evals frontend is misconfigured and cannot start.',
      '',
      missing.length ? `Missing required environment variables:` : '',
      ...missing.map((k) => `  - ${k}`),
      detail ? `\n${detail}` : '',
      '',
      'See .env.example for the full list, and docs/INTEGRATION.md §9 for what',
      'each value should point at.',
    ].filter(Boolean);

    super(lines.join('\n'));
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

/** Environment variables this app reads. Keep in sync with .env.example. */
const REQUIRED = [
  'VITE_EVALS_API',
  'VITE_DATASET_ID',
  'VITE_DATASET_NAME',
  'VITE_AGENT_ID',
  'VITE_AGENT_VERSION',
] as const;

/**
 * Read and validate configuration from the environment.
 *
 * @param env  Injected for testing. Defaults to `import.meta.env`.
 * @param overrides  Values supplied by a host application, which take
 *   precedence over the environment. When embedding this frontend, the host
 *   usually knows the agent id and version at runtime and should pass them
 *   here rather than baking them into a build.
 *
 * @throws {ConfigError} listing every missing variable at once — reporting
 *   them one at a time turns a single fix into several deploy cycles.
 */
export function loadConfig(
  env: Record<string, string | undefined> = import.meta.env as unknown as Record<
    string,
    string | undefined
  >,
  overrides: Partial<EvalsConfig> = {},
): EvalsConfig {
  const missing: string[] = [];

  const read = (key: (typeof REQUIRED)[number], override?: string): string => {
    if (override !== undefined && override !== '') return override;
    const v = env[key];
    if (v === undefined || v.trim() === '') {
      missing.push(key);
      return '';
    }
    return v.trim();
  };

  const config: EvalsConfig = {
    baseUrl: read('VITE_EVALS_API', overrides.baseUrl),
    datasetId: read('VITE_DATASET_ID', overrides.datasetId),
    datasetName: read('VITE_DATASET_NAME', overrides.datasetName),
    agentId: read('VITE_AGENT_ID', overrides.agentId),
    agentVersion: read('VITE_AGENT_VERSION', overrides.agentVersion),
    hasUnsavedChanges: overrides.hasUnsavedChanges ?? false,
  };

  if (missing.length) throw new ConfigError(missing);

  // A secret key in the browser bundle is a security incident, not a
  // misconfiguration. Fail loudly rather than starting in an unsafe state.
  // 📖 docs/INTEGRATION.md §1
  const secret = env.VITE_LANGFUSE_SECRET_KEY ?? env.VITE_SECRET_KEY;
  if (secret) {
    throw new ConfigError(
      [],
      'A Langfuse secret key was found in the browser environment.\n' +
        'Secret keys must never be exposed client-side. Point VITE_EVALS_API at\n' +
        'a backend proxy that injects credentials server-side instead.',
    );
  }

  // Pointing straight at Langfuse means credentials are being handled in the
  // browser, or will be. Warn rather than throw — a local dev project against
  // a throwaway instance is a legitimate case.
  if (/langfuse\.(com|cloud)/i.test(config.baseUrl)) {
    console.warn(
      '[evals] VITE_EVALS_API points directly at Langfuse. In production this ' +
        'must be your own proxy — see docs/INTEGRATION.md §1.',
    );
  }

  return config;
}

/**
 * Render a startup failure as readable HTML.
 *
 * A blank white page tells an operator nothing. This tells them which variable
 * is missing, which is usually the whole fix.
 */
export function renderConfigError(error: ConfigError, root: HTMLElement): void {
  root.innerHTML = `
    <div style="max-width:620px;margin:80px auto;padding:24px;
                font:14px/1.6 ui-sans-serif,system-ui,sans-serif;color:#12211c">
      <h1 style="font-size:18px;margin:0 0 12px">Evals could not start</h1>
      <pre style="background:#fbeceb;border:1px solid #eccfcd;border-radius:8px;
                  padding:16px;white-space:pre-wrap;overflow-wrap:anywhere;
                  font:13px/1.55 ui-monospace,Menlo,monospace;color:#7a1b16;margin:0"
      >${escapeHtml(error.message)}</pre>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}
