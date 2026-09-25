import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getRequestContext,
  setRequestContextUserId,
} from '../requestContext';

describe('requestContext (#26)', () => {
  it('returns undefined outside of any established context', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('exposes the context established by runWithRequestContext', () => {
    runWithRequestContext({ requestId: 'req-1' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'req-1' });
    });
  });

  it('setRequestContextUserId mutates the currently active context', () => {
    runWithRequestContext({ requestId: 'req-2' }, () => {
      setRequestContextUserId('user-42');
      expect(getRequestContext()).toEqual({ requestId: 'req-2', userId: 'user-42' });
    });
  });

  it('isolates concurrent contexts from each other', async () => {
    const results: Array<string | undefined> = [];

    await Promise.all([
      runWithRequestContext({ requestId: 'req-a' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getRequestContext()?.requestId);
      }),
      runWithRequestContext({ requestId: 'req-b' }, async () => {
        results.push(getRequestContext()?.requestId);
      }),
    ]);

    expect(results).toContain('req-a');
    expect(results).toContain('req-b');
  });

  it('does not leak a context set inside one run() call into a sibling call', () => {
    runWithRequestContext({ requestId: 'req-3' }, () => {
      setRequestContextUserId('user-3');
    });

    runWithRequestContext({ requestId: 'req-4' }, () => {
      expect(getRequestContext()).toEqual({ requestId: 'req-4' });
    });
  });
});
