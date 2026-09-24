import { describe, it, expect, vi } from 'vitest';
import { JobEventBus, createJobEvent } from '../events';

describe('JobEventBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new JobEventBus();
    const handler = vi.fn();
    bus.on('completed', handler);

    bus.emit(createJobEvent('completed', { queue: 'email', jobId: '1', name: 'email.send' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: 'completed', queue: 'email', jobId: '1' });
  });

  it('only notifies subscribers of the matching event type', () => {
    const bus = new JobEventBus();
    const completed = vi.fn();
    const failed = vi.fn();
    bus.on('completed', completed);
    bus.on('failed', failed);

    bus.emit(createJobEvent('failed', { queue: 'email', jobId: '1', name: 'email.send' }));

    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('supports unsubscribing', () => {
    const bus = new JobEventBus();
    const handler = vi.fn();
    const off = bus.on('completed', handler);

    off();
    bus.emit(createJobEvent('completed', { queue: 'email', jobId: '1', name: 'email.send' }));

    expect(handler).not.toHaveBeenCalled();
    expect(bus.listenerCount('completed')).toBe(0);
  });

  it('isolates listener failures', () => {
    const bus = new JobEventBus();
    const bad = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const good = vi.fn();
    bus.on('completed', bad);
    bus.on('completed', good);

    expect(() =>
      bus.emit(createJobEvent('completed', { queue: 'email', jobId: '1', name: 'email.send' }))
    ).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('clears all listeners', () => {
    const bus = new JobEventBus();
    bus.on('completed', vi.fn());
    bus.clear();
    expect(bus.listenerCount('completed')).toBe(0);
  });
});

describe('createJobEvent', () => {
  it('defaults the timestamp', () => {
    const event = createJobEvent('enqueued', { queue: 'email', jobId: '1', name: 'email.send' });
    expect(typeof event.timestamp).toBe('string');
    expect(new Date(event.timestamp).toString()).not.toBe('Invalid Date');
  });
});
