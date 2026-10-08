import { describe, it, expect, beforeEach } from 'vitest';
import { ModerationService, type ModerationNotifier } from '../moderation.service';
import { FakeModerationPrisma, asPrisma } from './fake-moderation-prisma';

const SPAM_TEXT =
  'Free crypto guaranteed returns, click the link below https://scam.example and email scam@example.com';

interface Notified {
  reportId: string;
  reporterId: string;
  reporterEmail: string;
  decision: string;
  resolution: string;
}

function harness() {
  const fake = new FakeModerationPrisma();
  const notified: Notified[] = [];
  const notifier: ModerationNotifier = {
    notifyReporter: async (input) => {
      notified.push(input as unknown as Notified);
    },
  };

  const admin = fake.seedUser({ email: 'mod@example.com', role: 'admin' });
  const reporter = fake.seedUser({ email: 'reporter@example.com', role: 'fan' });
  const author = fake.seedUser({ email: 'author@example.com', role: 'fan' });
  const stranger = fake.seedUser({ email: 'stranger@example.com', role: 'fan' });
  const tip = fake.seedTip({ fromUserId: author.id });

  const service = new ModerationService(asPrisma(fake), { notifier });

  return { fake, service, notified, admin, reporter, author, stranger, tip };
}

describe('ModerationService.createReport', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('queues an ordinary report at its type priority', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'harassment',
      reason: 'The message is abusive towards another supporter',
    });

    expect(report.status).toBe('reported');
    expect(report.priority).toBe('high');
    expect(report.autoFlagged).toBe(false);
    expect(report.spamScore).toBe(0);
    expect(h.tip.moderationState).toBe('visible');
  });

  it('auto-triages spam, moves it to investigating and hides it', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Obvious scam',
      details: SPAM_TEXT,
    });

    expect(report.status).toBe('investigating');
    expect(report.autoFlagged).toBe(true);
    expect(report.spamScore).toBeGreaterThanOrEqual(80);
    expect(report.priority).toBe('urgent');
    expect(h.tip.moderationState).toBe('hidden');

    const actions = h.fake.actions.map((entry) => entry.action);
    expect(actions).toEqual(['report.created', 'report.auto_triaged', 'content.hidden']);
    expect(h.fake.actions[2].actorId).toBe('system');
    expect(h.fake.actions[2].reportId).toBe(report.id);
  });

  it('refuses a second open report from the same reporter', async () => {
    await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Scam tip',
    });

    await expect(
      h.service.createReport(h.reporter.id, {
        targetType: 'tip',
        targetId: h.tip.id,
        reportType: 'spam',
        reason: 'Scam tip again',
      })
    ).rejects.toThrow(/already have an open report/i);
  });

  it('refuses a report against something that does not exist', async () => {
    await expect(
      h.service.createReport(h.reporter.id, {
        targetType: 'tip',
        targetId: 'nope',
        reportType: 'spam',
        reason: 'Scam tip',
      })
    ).rejects.toThrow(/not found/i);
  });

  it('supports users and creators as targets', async () => {
    const creator = h.fake.seedCreator({ userId: h.author.id });

    const onUser = await h.service.createReport(h.reporter.id, {
      targetType: 'user',
      targetId: h.stranger.id,
      reportType: 'inappropriate',
      reason: 'Their profile is abusive',
    });
    const onCreator = await h.service.createReport(h.reporter.id, {
      targetType: 'creator',
      targetId: creator.id,
      reportType: 'fraud',
      reason: 'They never delivered the promised work',
    });

    expect(onUser.priority).toBe('normal');
    expect(onCreator.priority).toBe('urgent');
  });

  it('lists the reports a user filed', async () => {
    await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Scam tip',
    });

    const mine = await h.service.listMyReports(h.reporter.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].reporterId).toBe(h.reporter.id);
    expect(await h.service.listMyReports(h.stranger.id)).toHaveLength(0);
  });
});

describe('ModerationService queue', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
  });

  async function seedQueue() {
    const low = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });
    const urgent = await h.service.createReport(h.stranger.id, {
      targetType: 'user',
      targetId: h.author.id,
      reportType: 'fraud',
      reason: 'They took my money and vanished',
    });
    return { low, urgent };
  }

  it('orders the open queue by urgency', async () => {
    const { low, urgent } = await seedQueue();

    const queue = await h.service.listQueue();
    expect(queue.items.map((report) => report.id)).toEqual([urgent.id, low.id]);
    expect(queue.counts).toEqual({ reported: 2, investigating: 0, resolved: 0, dismissed: 0 });
  });

  it('filters, pages and counts', async () => {
    await seedQueue();

    const byType = await h.service.listQueue({ reportType: 'fraud' });
    expect(byType.total).toBe(1);
    expect(byType.items[0].reportType).toBe('fraud');

    const page = await h.service.listQueue({ page: 2, pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasPrev).toBe(true);
    expect(page.hasNext).toBe(false);
    expect(page.totalPages).toBe(2);
  });

  it('hides closed reports unless they are asked for', async () => {
    const { low } = await seedQueue();
    await h.service.dismissReport(h.admin.id, low.id, { reason: 'Not a reportable issue' });

    expect((await h.service.listQueue()).total).toBe(1);
    const all = await h.service.listQueue({ includeClosed: true });
    expect(all.total).toBe(2);
    expect(all.counts.dismissed).toBe(1);

    const closed = await h.service.listQueue({ status: 'dismissed', includeClosed: true });
    expect(closed.total).toBe(1);
  });

  it('keeps the queue and the audit trail admin-only', async () => {
    await expect(h.service.listQueue()).resolves.toBeDefined();

    const { low } = await seedQueue();
    await expect(h.service.getReport(h.reporter.id, low.id)).rejects.toThrow(/moderator/i);
    await expect(
      h.service.dismissReport(h.reporter.id, low.id, { reason: 'let me in' })
    ).rejects.toThrow(/moderator/i);
  });
});

describe('ModerationService lifecycle', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('claims a report without letting two moderators share it', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });
    const other = h.fake.seedUser({ role: 'admin', email: 'mod2@example.com' });

    const claimed = await h.service.claimReport(h.admin.id, report.id, { priority: 'urgent' });
    expect(claimed.status).toBe('investigating');
    expect(claimed.assignedTo).toBe(h.admin.id);
    expect(claimed.priority).toBe('urgent');

    await expect(h.service.claimReport(other.id, report.id)).rejects.toThrow(/already assigned/i);
    // Re-claiming your own report is fine.
    await expect(h.service.claimReport(h.admin.id, report.id)).resolves.toBeDefined();
  });

  it('resolves with a decision, acts on the content and tells the reporter', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });

    const resolved = await h.service.resolveReport(h.admin.id, report.id, {
      decision: 'approved',
      resolution: 'Confirmed spam, tip removed',
      contentAction: 'remove',
      notes: 'Matched the known scam pattern',
    });

    expect(resolved.status).toBe('resolved');
    expect(resolved.decision).toBe('approved');
    expect(resolved.resolvedBy).toBe(h.admin.id);
    expect(resolved.resolvedAt).toBeTruthy();
    expect(h.tip.moderationState).toBe('removed');

    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({
      reportId: report.id,
      reporterId: h.reporter.id,
      reporterEmail: 'reporter@example.com',
      decision: 'approved',
    });

    const actions = h.fake.actions.map((entry) => entry.action);
    expect(actions).toContain('content.removed');
    expect(actions).toContain('report.resolved');
  });

  it('restores content when a report is not upheld', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Obvious scam',
      details: SPAM_TEXT,
    });
    expect(h.tip.moderationState).toBe('hidden');

    await h.service.resolveReport(h.admin.id, report.id, {
      decision: 'denied',
      resolution: 'The message is fine',
      contentAction: 'restore',
    });

    expect(h.tip.moderationState).toBe('visible');
  });

  it('cannot close the same report twice', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });

    await h.service.resolveReport(h.admin.id, report.id, {
      decision: 'denied',
      resolution: 'Nothing wrong here',
    });

    await expect(
      h.service.resolveReport(h.admin.id, report.id, {
        decision: 'approved',
        resolution: 'Changed my mind',
      })
    ).rejects.toThrow(/cannot be resolved/i);
    await expect(
      h.service.dismissReport(h.admin.id, report.id, { reason: 'duplicate' })
    ).rejects.toThrow(/cannot be dismissed/i);
  });

  it('keeps the decision when the email cannot be queued', async () => {
    const failing = new FakeModerationPrisma();
    const admin = failing.seedUser({ role: 'admin' });
    const reporter = failing.seedUser({});
    const tip = failing.seedTip({});
    const service = new ModerationService(asPrisma(failing), {
      notifier: {
        notifyReporter: async () => {
          throw new Error('queue down');
        },
      },
    });

    const report = await service.createReport(reporter.id, {
      targetType: 'tip',
      targetId: tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });
    const resolved = await service.resolveReport(admin.id, report.id, {
      decision: 'approved',
      resolution: 'Confirmed',
    });

    expect(resolved.status).toBe('resolved');
  });

  it('returns one report with its audit trail and appeals', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });
    await h.service.resolveReport(h.admin.id, report.id, {
      decision: 'approved',
      resolution: 'Confirmed spam',
    });
    await h.service.fileAppeal(h.author.id, report.id, { message: 'It was a joke, please restore' });

    const detail = await h.service.getReport(h.admin.id, report.id);

    expect(detail.report.id).toBe(report.id);
    expect(detail.audit.map((entry) => entry.action)).toContain('report.created');
    expect(detail.appeals).toHaveLength(1);
    expect(detail.appeals[0].appellantId).toBe(h.author.id);
  });
});

describe('ModerationService content actions', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('lets a moderator hide and restore content directly', async () => {
    await h.service.moderateContent(h.admin.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      action: 'hide',
      reason: 'Reported by three supporters',
    });
    expect(h.tip.moderationState).toBe('hidden');
    expect(await h.service.getContentState('tip', h.tip.id)).toBe('hidden');

    await h.service.moderateContent(h.admin.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      action: 'restore',
      reason: 'Report was not upheld',
    });
    expect(await h.service.getContentState('tip', h.tip.id)).toBe('visible');
  });

  it('refuses content actions from a non-moderator', async () => {
    await expect(
      h.service.moderateContent(h.stranger.id, {
        targetType: 'tip',
        targetId: h.tip.id,
        action: 'hide',
        reason: 'I do not like it',
      })
    ).rejects.toThrow(/moderator/i);

    expect(h.tip.moderationState).toBe('visible');
  });

  it('records who acted on content and why', async () => {
    await h.service.moderateContent(h.admin.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      action: 'remove',
      reason: 'Doxxing',
    });

    const trail = await h.service.getAuditTrail('tip', h.tip.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'content.removed',
      actorId: h.admin.id,
      reason: 'Doxxing',
    });
  });
});

describe('ModerationService appeals', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
  });

  async function resolvedReport() {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });
    await h.service.resolveReport(h.admin.id, report.id, {
      decision: 'approved',
      resolution: 'Confirmed spam',
      contentAction: 'remove',
    });
    return report;
  }

  it('lets the author of the content appeal once', async () => {
    const report = await resolvedReport();

    const appeal = await h.service.fileAppeal(h.author.id, report.id, {
      message: 'This was a quote from a movie, please restore it',
    });
    expect(appeal.status).toBe('pending');

    await expect(
      h.service.fileAppeal(h.author.id, report.id, { message: 'and again, please' })
    ).rejects.toThrow(/already been filed/i);
  });

  it('refuses an appeal from someone else', async () => {
    const report = await resolvedReport();

    await expect(
      h.service.fileAppeal(h.stranger.id, report.id, { message: 'I want this reviewed too' })
    ).rejects.toThrow(/author of the reported content/i);
  });

  it('refuses an appeal before the report is resolved', async () => {
    const report = await h.service.createReport(h.reporter.id, {
      targetType: 'tip',
      targetId: h.tip.id,
      reportType: 'spam',
      reason: 'Looks like spam to me',
    });

    await expect(
      h.service.fileAppeal(h.author.id, report.id, { message: 'It is still being looked at' })
    ).rejects.toThrow(/only a resolved report/i);
  });

  it('restores content when an appeal is accepted', async () => {
    const report = await resolvedReport();
    const appeal = await h.service.fileAppeal(h.author.id, report.id, {
      message: 'This was a quote from a movie, please restore it',
    });

    const reviewed = await h.service.reviewAppeal(h.admin.id, appeal.id, {
      status: 'accepted',
      notes: 'Checked the context, restoring',
    });

    expect(reviewed.status).toBe('accepted');
    expect(h.tip.moderationState).toBe('visible');
    expect((await h.service.getAuditTrail('tip', h.tip.id)).map((e) => e.action)).toContain(
      'content.restored'
    );
    await expect(h.service.reviewAppeal(h.admin.id, appeal.id, {
      status: 'rejected',
      notes: 'second thoughts',
    })).rejects.toThrow(/already been reviewed/i);
  });

  it('leaves content down when an appeal is rejected', async () => {
    const report = await resolvedReport();
    const appeal = await h.service.fileAppeal(h.author.id, report.id, {
      message: 'This was a quote from a movie, please restore it',
    });

    await h.service.reviewAppeal(h.admin.id, appeal.id, {
      status: 'rejected',
      notes: 'The quote was still a scam link',
    });

    expect(h.tip.moderationState).toBe('removed');
    expect(await h.service.listAppeals('rejected')).toHaveLength(1);
    expect(await h.service.listAppeals('pending')).toHaveLength(0);
  });

  it('keeps appeals behind the moderator role', async () => {
    const report = await resolvedReport();
    const appeal = await h.service.fileAppeal(h.author.id, report.id, {
      message: 'This was a quote from a movie, please restore it',
    });

    await expect(
      h.service.reviewAppeal(h.stranger.id, appeal.id, { status: 'accepted', notes: 'ok' })
    ).rejects.toThrow(/moderator/i);
  });
});
