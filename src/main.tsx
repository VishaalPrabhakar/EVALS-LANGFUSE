/**
 * Dev entry point.
 *
 * In production your host app renders <App config={...}> or <EvalsRoutes/>
 * directly. This file exists so `npm run dev` has something to boot.
 *
 * Config is validated at startup by `loadConfig()` rather than read inline —
 * a missing variable produces a readable error here instead of a confusing
 * network failure later. 📖 docs/PRODUCTION_READINESS.md item 5
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ConfigError, loadConfig, renderConfigError } from './config';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found in index.html');

try {
  const config = loadConfig();
  createRoot(root).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
} catch (e) {
  // A blank page tells an operator nothing. Show what is missing.
  if (e instanceof ConfigError) renderConfigError(e, root);
  else throw e;
}
