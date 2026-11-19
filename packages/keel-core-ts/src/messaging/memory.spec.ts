// Unit tests for the in-memory dev/test MessageBus. Broker-free: it dispatches synchronously in
// process. Covers fan-out to every subscriber of a subject, isolation between subjects, carrying
// application headers, and publishing to a subject with no subscribers.
import { describe, expect, it } from 'vitest';

import { type InboundMessage } from './index.js';
import { InMemoryMessageBus } from './memory.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('InMemoryMessageBus', () => {
  it('delivers a published message to every subscriber of the subject', async () => {
    const bus = new InMemoryMessageBus();
    const first: InboundMessage[] = [];
    const second: InboundMessage[] = [];
    await bus.subscribe('keel.orders', (m) => {
      first.push(m);
      return Promise.resolve();
    });
    await bus.subscribe('keel.orders', (m) => {
      second.push(m);
      return Promise.resolve();
    });

    await bus.publish('keel.orders', encode('payload'), { headers: { 'x-k': 'v' } });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.subject).toBe('keel.orders');
    expect(new TextDecoder().decode(first[0]?.payload)).toBe('payload');
    // Application headers are carried through to the delivered message.
    expect(first[0]?.headers['x-k']).toBe('v');
  });

  it('does not deliver across subjects', async () => {
    const bus = new InMemoryMessageBus();
    const received: InboundMessage[] = [];
    await bus.subscribe('keel.orders', (m) => {
      received.push(m);
      return Promise.resolve();
    });

    await bus.publish('keel.audit', encode('other'));

    expect(received).toHaveLength(0);
  });

  it('is a no-op when publishing to a subject with no subscribers', async () => {
    const bus = new InMemoryMessageBus();
    await expect(bus.publish('keel.unseen', encode('x'))).resolves.toBeUndefined();
  });
});
