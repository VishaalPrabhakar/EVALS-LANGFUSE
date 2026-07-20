/** Vitest setup: jest-dom matchers plus jsdom gaps React/Router rely on. */
import '@testing-library/jest-dom/vitest';

// jsdom lacks matchMedia; the reduced-motion query in tokens.css and any
// responsive hook will throw without it.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom does not implement scrollTo; routes call it on navigation.
window.scrollTo = (() => {}) as typeof window.scrollTo;
