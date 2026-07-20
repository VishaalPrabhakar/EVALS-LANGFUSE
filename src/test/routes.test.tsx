/**
 * ============================================================================
 * ROUTE & NAVIGATION EDGE CASES
 * ============================================================================
 *
 * Covers every navigable state, including the ones that only occur when data
 * is missing, empty, or broken. Numbered to match docs/EDGE_CASES.md.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentHome from '../routes/AgentHome';
import Library from '../routes/Library';
import SuiteEditor from '../routes/SuiteEditor';
import RunResults from '../routes/RunResults';
import Compare from '../routes/Compare';
import {
  makeLibrary,
  page,
  renderRoute,
  stubClient,
  toLangfuseItem,
} from './fixtures';

/** Standard stub: full library, one run, results for it. */
function fullStub(opts: { items?: ReturnType<typeof makeLibrary>; runs?: unknown[] } = {}) {
  const items = opts.items ?? makeLibrary();
  return stubClient({
    '/dataset-items': () => page(items.map(toLangfuseItem)),
    '/runs': () =>
      opts.runs ?? [
        { id: 'r1', name: 'run-b', datasetId: 'ds_lib', createdAt: '2026-07-19T12:00:00Z', metadata: { agentVersion: 'v14' } },
        { id: 'r0', name: 'run-a', datasetId: 'ds_lib', createdAt: '2026-07-12T09:00:00Z', metadata: { agentVersion: 'v11' } },
      ],
    '/dataset-run-items': () =>
      page([{ id: 'ri1', datasetRunId: 'r1', datasetItemId: 'q2', traceId: 't1' }]),
    '/scores': () =>
      page([
        {
          id: 's1',
          name: 'correctness',
          value: 0,
          dataType: 'BOOLEAN',
          traceId: 't1',
          comment: '{"causeId":"scope","cause":"No scope boundary","fix":"Add a scope rule"}',
        },
      ]),
    '/traces/': () => ({ id: 't1', output: { answer: 'Sure! Here is a joke.' } }),
  });
}

// ---------------------------------------------------------------------------
// AGENT HOME
// ---------------------------------------------------------------------------

describe('EDGE 25 — agent home first-run state', () => {
  it('shows ONE empty state with ONE primary action when nothing exists', async () => {
    // The original design showed three competing empty states that pointed at
    // each other. There must be exactly one call to action here.
    const client = stubClient({ '/dataset-items': () => page([]), '/runs': () => [] });
    renderRoute(<AgentHome />, { client });

    expect(await screen.findByText(/write your first test question/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /generate questions with ai/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /write one myself/i })).toBeInTheDocument();
    // No suite list, no run button competing for attention.
    expect(screen.queryByRole('button', { name: /run all suites/i })).not.toBeInTheDocument();
  });

  it('lists suites, never questions, once questions exist', async () => {
    renderRoute(<AgentHome />, { client: fullStub() });
    expect(await screen.findByText('Smoke')).toBeInTheDocument();
    expect(screen.getByText('Full regression')).toBeInTheDocument();
    // The long question text must NOT appear — this view is bounded by suite
    // count, not library size.
    expect(screen.queryByText(/starter bundle during the spring sale/i)).not.toBeInTheDocument();
  });

  it('shows a stale-draft warning when the editor has unsaved changes', async () => {
    // ADR-001: runs target the saved version, so an unsaved draft means the
    // user would test something they are not looking at.
    renderRoute(<AgentHome />, {
      client: fullStub(),
      config: { hasUnsavedChanges: true },
    });
    expect(await screen.findByText(/tests run against the last saved version/i)).toBeInTheDocument();
  });

  it('surfaces orphan questions in the coverage panel', async () => {
    renderRoute(<AgentHome />, { client: fullStub() });
    expect(await screen.findByText(/not in any suite — this never runs/i)).toBeInTheDocument();
  });

  it('shows an error state with retry when the library fails to load', async () => {
    const client = stubClient({
      '/dataset-items': () => new Response('{}', { status: 500 }),
      '/runs': () => [],
    });
    renderRoute(<AgentHome />, { client });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// LIBRARY
// ---------------------------------------------------------------------------

describe('EDGE 26 — library view', () => {
  it('shows the Used in column so shared editing is not a surprise', async () => {
    renderRoute(<Library />, { client: fullStub() });
    await screen.findByText('Refund window');
    // q2 is in three suites.
    expect(screen.getByText('3 suites')).toBeInTheDocument();
  });

  it('flags orphans distinctly from suite members', async () => {
    renderRoute(<Library />, { client: fullStub() });
    expect(await screen.findByText('Not in a suite')).toBeInTheDocument();
  });

  it('renders an explicit marker for empty criteria, not a blank cell', async () => {
    // A blank cell reads as a rendering bug; "No criteria set" reads as a
    // state the user can act on.
    renderRoute(<Library />, { client: fullStub() });
    expect(await screen.findByText(/no criteria set/i)).toBeInTheDocument();
  });

  it('hides archived questions by default', async () => {
    renderRoute(<Library />, { client: fullStub() });
    await screen.findByText('Refund window');
    expect(screen.queryByText('Deprecated check')).not.toBeInTheDocument();
  });

  it('filters by search across name, prompt and criteria', async () => {
    const user = userEvent.setup();
    renderRoute(<Library />, { client: fullStub() });
    await screen.findByText('Refund window');

    await user.type(screen.getByLabelText(/search questions/i), 'joke');
    await waitFor(() => {
      expect(screen.queryByText('Refund window')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Out of scope')).toBeInTheDocument();
  });

  it('offers a way out when a filter matches nothing', async () => {
    // A dead-end empty state is a trap — there must always be an escape.
    const user = userEvent.setup();
    renderRoute(<Library />, { client: fullStub() });
    await screen.findByText('Refund window');

    await user.type(screen.getByLabelText(/search questions/i), 'zzzznomatch');
    expect(await screen.findByText(/no questions match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();
  });

  it('shows the cap counter', async () => {
    renderRoute(<Library />, { client: fullStub() });
    expect(await screen.findByText(/\/ 100 questions/)).toBeInTheDocument();
  });

  it('warns before archiving the last question in a suite', async () => {
    // Silently emptying a suite drops coverage without telling anyone.
    const user = userEvent.setup();
    const items = makeLibrary().map((q) =>
      q.id === 'q3' ? { ...q, suites: ['Solo'] } : q,
    );
    renderRoute(<Library />, { client: fullStub({ items }) });
    await screen.findByText('Refund window');

    const row = screen.getByText('Partial refund on a discounted bundle').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /archive/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/last question in/i)).toBeInTheDocument();
    expect(within(dialog).getByText('Solo')).toBeInTheDocument();
  });

  it('can cancel the archive confirmation without archiving', async () => {
    const user = userEvent.setup();
    renderRoute(<Library />, { client: fullStub() });
    await screen.findByText('Refund window');

    const row = screen.getByText('Refund window').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /archive/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Refund window')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SUITE EDITOR
// ---------------------------------------------------------------------------

describe('EDGE 27 — suite editor', () => {
  it('pre-ticks the questions already in the suite', async () => {
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/Smoke',
      route: '/suites/:suiteName',
    });
    await screen.findByText('Refund window');
    expect(screen.getByLabelText('Include Refund window')).toBeChecked();
    // q5 is only in Full regression.
    expect(screen.getByLabelText('Include Pricing')).not.toBeChecked();
  });

  it('has NO copy affordance — membership is selection only', async () => {
    // The absence of a copy button is what makes drift structurally
    // impossible. If this test fails, the model has been broken.
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/Smoke',
      route: '/suites/:suiteName',
    });
    await screen.findByText('Refund window');
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /duplicate/i })).not.toBeInTheDocument();
  });

  it('explains that unticking does not delete the question', async () => {
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/Smoke',
      route: '/suites/:suiteName',
    });
    expect(
      await screen.findByText(/stays in the library and in any other suite/i),
    ).toBeInTheDocument();
  });

  it('warns when a suite exists but has no questions left', async () => {
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/Ghost',
      route: '/suites/:suiteName',
    });
    expect(await screen.findByText(/this suite has no questions/i)).toBeInTheDocument();
  });

  it('directs the user to the library when there is nothing to select', async () => {
    const client = stubClient({ '/dataset-items': () => page([]), '/runs': () => [] });
    renderRoute(<SuiteEditor />, {
      client,
      path: '/suites/new',
      route: '/suites/:suiteName',
    });
    expect(await screen.findByText(/no questions to select/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to library/i })).toBeInTheDocument();
  });

  it('disables save until a new suite has a name', async () => {
    const user = userEvent.setup();
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/new',
      route: '/suites/:suiteName',
    });
    await screen.findByText('Refund window');

    const save = screen.getByRole('button', { name: /save suite/i });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/suite name/i), 'Quick');
    expect(save).toBeEnabled();
  });

  it('updates the selected count as boxes are ticked', async () => {
    // The denominator is 5, not 6: the archived question is excluded from the
    // selectable set. You cannot add an archived question to a suite, so
    // offering it would be a dead checkbox.
    const user = userEvent.setup();
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/Smoke',
      route: '/suites/:suiteName',
    });
    await screen.findByText('Refund window');

    expect(screen.getByText(/2 of 5 questions selected/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Include Pricing'));
    expect(await screen.findByText(/3 of 5 questions selected/i)).toBeInTheDocument();
  });

  it('does not offer archived questions as selectable', async () => {
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/Smoke',
      route: '/suites/:suiteName',
    });
    await screen.findByText('Refund window');
    expect(screen.queryByLabelText('Include Deprecated check')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RESULTS
// ---------------------------------------------------------------------------

describe('EDGE 28 — run results', () => {
  it('groups failures by root cause with one fix action', async () => {
    renderRoute(<RunResults />, {
      client: fullStub(),
      path: '/runs/run-b',
      route: '/runs/:runName',
    });
    expect(await screen.findByText('No scope boundary')).toBeInTheDocument();
    expect(screen.getByText('Add a scope rule')).toBeInTheDocument();
    // One apply button for the cause, not one per failing test.
    expect(screen.getAllByRole('button', { name: /apply to system prompt/i })).toHaveLength(1);
  });

  it('shows expected vs actual for a failure', async () => {
    renderRoute(<RunResults />, {
      client: fullStub(),
      path: '/runs/run-b',
      route: '/runs/:runName',
    });
    await screen.findByText('No scope boundary');
    expect(screen.getByText(/a good answer includes/i)).toBeInTheDocument();
    expect(screen.getByText(/your agent said/i)).toBeInTheDocument();
  });

  it('renders a not-found state for an unknown run', async () => {
    renderRoute(<RunResults />, {
      client: fullStub(),
      path: '/runs/does-not-exist',
      route: '/runs/:runName',
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('handles a run that produced no results', async () => {
    // The trigger succeeded but nothing executed — an empty suite, or the
    // backend wrote no items. This must not render as 0% failure.
    const client = stubClient({
      '/dataset-items': () => page(makeLibrary().map(toLangfuseItem)),
      '/runs': () => [{ id: 'r1', name: 'empty-run', datasetId: 'ds', createdAt: '2026-07-19T12:00:00Z' }],
      '/dataset-run-items': () => page([]),
      '/scores': () => page([]),
    });
    renderRoute(<RunResults />, {
      client,
      path: '/runs/empty-run',
      route: '/runs/:runName',
    });
    expect(await screen.findByText(/this run has no results/i)).toBeInTheDocument();
  });

  it('separates unscored questions from failures', async () => {
    // An unreadable score is an evaluation problem, not an agent failure.
    const client = stubClient({
      '/dataset-items': () => page(makeLibrary().map(toLangfuseItem)),
      '/runs': () => [{ id: 'r1', name: 'run-x', datasetId: 'ds', createdAt: '2026-07-19T12:00:00Z' }],
      '/dataset-run-items': () =>
        page([{ id: 'ri1', datasetRunId: 'r1', datasetItemId: 'q1', traceId: 't1' }]),
      '/scores': () => page([]), // no score at all
      '/traces/': () => ({ id: 't1', output: 'something' }),
    });
    renderRoute(<RunResults />, {
      client,
      path: '/runs/run-x',
      route: '/runs/:runName',
    });
    expect(await screen.findByText(/couldn't be scored/i)).toBeInTheDocument();
    expect(screen.getByText(/not an agent failure/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// COMPARE
// ---------------------------------------------------------------------------

describe('EDGE 29 — compare runs', () => {
  it('explains that comparison needs two runs', async () => {
    const client = stubClient({
      '/dataset-items': () => page(makeLibrary().map(toLangfuseItem)),
      '/runs': () => [{ id: 'r1', name: 'only', datasetId: 'ds', createdAt: '2026-07-19T12:00:00Z' }],
    });
    renderRoute(<Compare />, { client, path: '/compare' });
    expect(await screen.findByText(/nothing to compare yet/i)).toBeInTheDocument();
  });

  it('prompts for a selection when no runs are chosen', async () => {
    renderRoute(<Compare />, { client: fullStub(), path: '/compare' });
    expect(await screen.findByText(/pick two runs/i)).toBeInTheDocument();
  });

  it('catches comparing a run against itself', async () => {
    renderRoute(<Compare />, { client: fullStub(), path: '/compare?a=run-a&b=run-a' });
    expect(await screen.findByText(/those are the same run/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ACCESSIBILITY FLOOR
// ---------------------------------------------------------------------------

describe('EDGE 30 — accessibility floor', () => {
  it('labels every interactive control', async () => {
    renderRoute(<Library />, { client: fullStub() });
    await screen.findByText('Refund window');
    for (const el of screen.getAllByRole('button')) {
      const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it('labels checkboxes individually in the suite editor', async () => {
    renderRoute(<SuiteEditor />, {
      client: fullStub(),
      path: '/suites/Smoke',
      route: '/suites/:suiteName',
    });
    await screen.findByText('Refund window');
    for (const cb of screen.getAllByRole('checkbox')) {
      expect(cb).toHaveAccessibleName();
    }
  });

  it('announces errors with an alert role', async () => {
    const client = stubClient({
      '/dataset-items': () => new Response('{}', { status: 500 }),
      '/runs': () => [],
    });
    renderRoute(<AgentHome />, { client });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('marks the archive confirmation as a modal dialog', async () => {
    const user = userEvent.setup();
    renderRoute(<Library />, { client: fullStub() });
    await screen.findByText('Refund window');

    const row = screen.getByText('Refund window').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /archive/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
  });
});
