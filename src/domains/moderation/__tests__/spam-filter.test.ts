import { describe, it, expect } from 'vitest';
import {
  AUTO_HIDE_SCORE,
  AUTO_INVESTIGATE_SCORE,
  SPAM_RULES,
  scoreReport,
  scoreReportFields,
} from '../spam-filter';

describe('scoreReport', () => {
  it('leaves an ordinary message alone', () => {
    const verdict = scoreReport('Thanks for the great stream yesterday!', 'spam');

    expect(verdict.score).toBe(0);
    expect(verdict.spam).toBe(false);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.autoHide).toBe(false);
  });

  it('scores a scam tip past the auto-investigate threshold', () => {
    const verdict = scoreReport(
      'Guaranteed returns on your tip, see www.example.com',
      'spam'
    );

    expect(verdict.score).toBeGreaterThanOrEqual(AUTO_INVESTIGATE_SCORE);
    expect(verdict.score).toBeLessThan(AUTO_HIDE_SCORE);
    expect(verdict.reasons).toContain('bait_phrase');
    expect(verdict.reasons).toContain('single_link');
    expect(verdict.autoHide).toBe(false);
    expect(verdict.priority).toBe('high');
  });

  it('hides high-confidence spam while it is reviewed', () => {
    const verdict = scoreReport(
      'Free crypto guaranteed returns, click the link below https://scam.example and email scam@example.com',
      'spam'
    );

    expect(verdict.score).toBeGreaterThanOrEqual(AUTO_HIDE_SCORE);
    expect(verdict.spam).toBe(true);
    expect(verdict.autoHide).toBe(true);
    expect(verdict.priority).toBe('urgent');
  });

  it('caps the score at 100', () => {
    const everything = 'FREE CRYPTO guaranteed returns!!! click the link below https://a.example www.b.example mail@example.com +1 555 123 4567 aaaaaaaa';
    expect(scoreReport(everything, 'spam').score).toBe(100);
  });

  it('takes the report type as the floor for the priority', () => {
    // Nothing in the text looks like spam, but harassment is read first anyway.
    expect(scoreReport('you are mean', 'harassment').priority).toBe('high');
    expect(scoreReport('you are mean', 'fraud').priority).toBe('urgent');
    expect(scoreReport('you are mean', 'spam').priority).toBe('low');
  });

  it('does not auto-hide copyright reports on the strength of their wording', () => {
    // A takedown notice legitimately quotes the content it complains about.
    const verdict = scoreReport(
      'Free crypto guaranteed returns, click the link below https://scam.example mail@example.com',
      'copyright'
    );

    expect(verdict.score).toBeGreaterThanOrEqual(AUTO_HIDE_SCORE);
    expect(verdict.autoHide).toBe(false);
  });

  it('detects shouting without being case-blind', () => {
    expect(scoreReport('THIS IS A COMPLETE SCAM EVERYONE', 'spam').reasons).toContain('shouting');
    expect(scoreReport('this is a complete scam everyone', 'spam').reasons).not.toContain('shouting');
  });

  it('detects a message that is one word repeated', () => {
    expect(scoreReport('buy buy buy buy buy', 'spam').reasons).toContain('repeated_message');
  });

  it('scores the reason and the details together', () => {
    const verdict = scoreReportFields({
      reason: 'This is spam',
      details: 'FREE CRYPTO guaranteed returns',
      reportType: 'spam',
    });

    expect(verdict.reasons).toContain('bait_phrase');
  });

  it('keeps rule names unique so the audit trail stays readable', () => {
    const names = SPAM_RULES.map((rule) => rule.name);

    expect(new Set(names).size).toBe(names.length);
    for (const rule of SPAM_RULES) expect(rule.weight).toBeGreaterThan(0);
  });
});
