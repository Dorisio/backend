import { describe, it, expect } from 'vitest';
import {
  renderDigestEmail,
  renderNotification,
  renderTemplateString,
  summariseForDigest,
} from '../notification.templates';

describe('renderTemplateString', () => {
  it('interpolates placeholders and collapses missing values', () => {
    expect(renderTemplateString('{{a}} and {{b}}', { a: 'one', b: 2 })).toBe('one and 2');
    expect(renderTemplateString('{{missing}}!', {})).toBe('!');
    expect(renderTemplateString('{{user.name}}', { user: { name: 'Ada' } })).toBe('Ada');
    // Objects and arrays are not printed into a user-facing string.
    expect(renderTemplateString('[{{list}}]', { list: [1, 2] })).toBe('[]');
  });

  it('escapes user-generated content', () => {
    const rendered = renderTemplateString('{{name}}', { name: '<script>alert("x")</script>' });

    expect(rendered).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});

describe('renderNotification', () => {
  it('renders a template from the event payload', () => {
    const rendered = renderNotification('tip.received', {
      data: { senderName: 'Ada', amount: 25, asset: 'XLM' },
    });

    expect(rendered.title).toBe('New tip received');
    expect(rendered.body).toBe('Ada tipped 25 XLM.');
    expect(rendered.subject).toBe('You received a tip of 25 XLM');
  });

  it('falls back to the title when a body renders empty', () => {
    const rendered = renderNotification('account.warning', { data: {} });

    expect(rendered.title).toBe('Account warning');
    expect(rendered.body).toBe('Account warning');
  });

  it('refuses an event with no template', () => {
    expect(() => renderNotification('nope' as never, { data: {} })).toThrow(/no notification template/i);
  });
});

describe('digest rendering', () => {
  const entries = [
    { type: 'tip.received', title: 'New tip received', body: 'Ada tipped 25 XLM.' },
    { type: 'tip.received', title: 'New tip received', body: 'Grace tipped 5 XLM.' },
    { type: 'payout.completed', title: 'Payout completed', body: 'Your payout was sent.' },
  ];

  it('summarises the window by event type', () => {
    expect(summariseForDigest(entries)).toBe('3 updates: 2 × tip.received, 1 × payout.completed');
    expect(summariseForDigest([])).toBe('');
    expect(summariseForDigest([entries[0]])).toBe('Ada tipped 25 XLM.');
  });

  it('renders the digest email', () => {
    const digest = renderDigestEmail('weekly', entries);

    expect(digest.subject).toBe('Your weekly Dorisio summary');
    expect(digest.body).toContain('Weekly summary: 3 updates');
    expect(digest.body).toContain('- New tip received: Ada tipped 25 XLM.');
  });
});
