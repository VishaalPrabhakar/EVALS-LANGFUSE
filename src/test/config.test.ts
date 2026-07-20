/**
 * ============================================================================
 * CONFIG VALIDATION — EDGE CASES 31
 * ============================================================================
 * Startup validation exists so misconfiguration fails readably instead of as
 * a confusing network error later. 📖 docs/PRODUCTION_READINESS.md item 5
 * ============================================================================
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { ConfigError, loadConfig, renderConfigError } from '../config';

const FULL = {
  VITE_EVALS_API: '/api/evals',
  VITE_DATASET_ID: 'ds_1',
  VITE_DATASET_NAME: 'agent-lib',
  VITE_AGENT_ID: 'agent_1',
  VITE_AGENT_VERSION: 'v14',
};

afterEach(() => vi.restoreAllMocks());

describe('EDGE 31 — configuration validation', () => {
  it('loads a complete environment', () => {
    const c = loadConfig(FULL);
    expect(c.datasetId).toBe('ds_1');
    expect(c.agentVersion).toBe('v14');
    expect(c.hasUnsavedChanges).toBe(false);
  });

  it('reports EVERY missing variable at once, not just the first', () => {
    // Reporting one at a time turns a single fix into several deploy cycles.
    const err = (() => {
      try {
        loadConfig({ VITE_EVALS_API: '/api' });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.missing).toEqual([
      'VITE_DATASET_ID',
      'VITE_DATASET_NAME',
      'VITE_AGENT_ID',
      'VITE_AGENT_VERSION',
    ]);
  });

  it('names the missing variables in the message', () => {
    try {
      loadConfig({});
    } catch (e) {
      expect((e as ConfigError).message).toContain('VITE_DATASET_ID');
      expect((e as ConfigError).message).toContain('.env.example');
    }
  });

  it('treats an empty or whitespace value as missing', () => {
    // A variable set to '' in a deploy manifest is a common failure and is
    // indistinguishable from absent as far as the app is concerned.
    try {
      loadConfig({ ...FULL, VITE_DATASET_ID: '   ' });
    } catch (e) {
      expect((e as ConfigError).missing).toEqual(['VITE_DATASET_ID']);
    }
  });

  it('trims surrounding whitespace from values', () => {
    expect(loadConfig({ ...FULL, VITE_AGENT_ID: '  agent_2  ' }).agentId).toBe('agent_2');
  });

  it('lets host overrides satisfy a missing variable', () => {
    // An embedding host usually knows the agent at runtime and should not have
    // to bake it into a build.
    const c = loadConfig(
      { ...FULL, VITE_AGENT_ID: undefined },
      { agentId: 'from-host' },
    );
    expect(c.agentId).toBe('from-host');
  });

  it('gives host overrides precedence over the environment', () => {
    expect(loadConfig(FULL, { agentVersion: 'v99' }).agentVersion).toBe('v99');
  });

  it('THROWS if a Langfuse secret key is present in the browser environment', () => {
    // This is a security incident, not a misconfiguration. Failing to start is
    // the correct behaviour. 📖 docs/INTEGRATION.md §1
    expect(() =>
      loadConfig({ ...FULL, VITE_LANGFUSE_SECRET_KEY: 'sk-lf-abc' }),
    ).toThrow(ConfigError);

    expect(() => loadConfig({ ...FULL, VITE_SECRET_KEY: 'sk-abc' })).toThrow(
      /never be exposed client-side/,
    );
  });

  it('warns but does not throw when pointed straight at Langfuse', () => {
    // Local dev against a throwaway project is legitimate; production is not.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({ ...FULL, VITE_EVALS_API: 'https://cloud.langfuse.com/api/public' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proxy'));
  });

  it('does not warn for a normal proxy path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig(FULL);
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders a readable startup failure instead of a blank page', () => {
    const root = document.createElement('div');
    renderConfigError(new ConfigError(['VITE_DATASET_ID']), root);
    expect(root.textContent).toContain('Evals could not start');
    expect(root.textContent).toContain('VITE_DATASET_ID');
  });

  it('escapes HTML in the error output', () => {
    // Env values reach this renderer; unescaped output would be an injection.
    const root = document.createElement('div');
    renderConfigError(new ConfigError([], '<img src=x onerror=alert(1)>'), root);
    expect(root.innerHTML).not.toContain('<img');
    expect(root.innerHTML).toContain('&lt;img');
  });
});
