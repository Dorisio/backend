/**
 * Automatic report triage (issue #62).
 *
 * Rules, not a model: they run on every report so the queue is pre-scored before
 * a human opens it, and each rule explains itself in `reasons`, which is what an
 * admin sees. Scores are additive and capped at 100:
 *
 *   score < 40   → the report stays `reported` at its type's default priority
 *   score >= 40  → `investigating`, priority high
 *   score >= 80  → content is hidden while the report is open
 *
 * The thresholds are exported so the moderation queue's behaviour is explicit
 * and testable rather than buried in an `if`.
 */

import { PRIORITY_BY_REPORT_TYPE, type ReportPriority, type ReportType } from './moderation.types';

export const AUTO_INVESTIGATE_SCORE = 40;
export const AUTO_HIDE_SCORE = 80;

export interface SpamRule {
  name: string;
  weight: number;
  /** Rules that look at capitalisation must see the original text. */
  caseSensitive?: boolean;
  test: (text: string) => boolean;
}

export interface SpamVerdict {
  spam: boolean;
  score: number;
  reasons: string[];
  /** Set when the score is high enough to hide the content while it is reviewed. */
  autoHide: boolean;
  priority: ReportPriority;
}

/** Words that show up in the overwhelming majority of scam tips. */
const BAIT_PHRASES = [
  'free crypto',
  'double your',
  'guaranteed returns',
  'claim your reward',
  'airdrop claim',
  'seed phrase',
  'private key',
  'investment opportunity',
  'send xlm to',
  'click the link below',
];

const LINK_PATTERN = /(https?:\/\/|www\.)[^\s]+/gi;
const CONTACT_PATTERN = /(\+?\d[\d\s().-]{7,}\d)|([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

export const SPAM_RULES: SpamRule[] = [
  {
    name: 'bait_phrase',
    weight: 45,
    test: (text) => BAIT_PHRASES.some((phrase) => text.includes(phrase)),
  },
  {
    name: 'multiple_links',
    weight: 25,
    test: (text) => (text.match(LINK_PATTERN) ?? []).length >= 2,
  },
  {
    name: 'single_link',
    weight: 15,
    test: (text) => (text.match(LINK_PATTERN) ?? []).length === 1,
  },
  {
    name: 'contact_details',
    // Tip messages never need a phone number or an email address in them.
    weight: 20,
    test: (text) => (text.match(CONTACT_PATTERN) ?? []).length > 0,
  },
  {
    name: 'shouting',
    // 60%+ of a message longer than 12 characters in capitals.
    caseSensitive: true,
    weight: 20,
    test: (text) => {
      const letters = text.replace(/[^a-z]/gi, '');
      if (letters.length < 12) return false;
      return (text.replace(/[^A-Z]/g, '').length / letters.length) >= 0.6;
    },
  },
  {
    name: 'repeated_characters',
    weight: 15,
    test: (text) => /(.)\1{6,}/.test(text),
  },
  {
    name: 'repeated_message',
    // A message that is just the same word repeated is a spam signature.
    weight: 15,
    test: (text) => {
      const words = text.split(/\s+/).filter(Boolean);
      return words.length >= 4 && new Set(words.map((word) => word.toLowerCase())).size === 1;
    },
  },
];

/**
 * Scores `text`. The report type shifts the result too: a harassment report is
 * never "low priority", whatever the message looks like.
 */
export function scoreReport(
  text: string,
  reportType: ReportType
): SpamVerdict {
  const normalised = text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  for (const rule of SPAM_RULES) {
    if (rule.test(rule.caseSensitive ? text : normalised)) {
      score += rule.weight;
      reasons.push(rule.name);
    }
  }

  score = Math.min(100, score);

  const basePriority = PRIORITY_BY_REPORT_TYPE[reportType];
  const priority: ReportPriority =
    score >= AUTO_HIDE_SCORE
      ? 'urgent'
      : score >= AUTO_INVESTIGATE_SCORE
        ? 'high'
        : basePriority;

  return {
    spam: reasons.length > 0,
    score,
    reasons,
    autoHide: score >= AUTO_HIDE_SCORE && reportType !== 'copyright',
    priority,
  };
}

/** Convenience wrapper for the fields a report carries. */
export function scoreReportFields(input: {
  reason: string;
  details?: string | null;
  reportType: ReportType;
}): SpamVerdict {
  return scoreReport(`${input.reason} ${input.details ?? ''}`.trim(), input.reportType);
}
