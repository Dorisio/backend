import { describe, expect, it } from 'vitest';
import { renderEmail } from './email';

describe('notification email templates', () => {
  it('renders verification templates and escapes untrusted substitutions', () => {
    const rendered = renderEmail('verification', {
      name: '<script>alert(1)</script>',
      link: 'https://example.com/verify?a=1&b=2',
    });
    expect(rendered.subject).toBe('Verify your Dorisio account');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('&amp;');
  });

  it('renders password-reset and user notification templates', () => {
    expect(renderEmail('password-reset', { name: 'Ada', link: '/reset' }).subject)
      .toBe('Reset your Dorisio password');
    expect(renderEmail('notification', { subject: 'Update', message: 'Hello' }).html)
      .toContain('<p>Hello</p>');
  });
});
