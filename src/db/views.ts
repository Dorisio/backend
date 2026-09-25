import { Pool } from 'pg';
import { logger } from '../utils/logger';

export const DATABASE_VIEWS = {
  CREATOR_ANALYTICS_SUMMARY: `
    CREATE OR REPLACE VIEW creator_analytics_summary_view AS
    SELECT
      c.id AS creator_id,
      c."userId" AS user_id,
      c.username,
      c."totalEarnings" AS total_earnings_stored,
      c."pendingBalance" AS pending_balance,
      COUNT(t.id)::int AS total_confirmed_tips,
      COALESCE(SUM(t.amount), 0)::float AS total_earnings,
      COALESCE(AVG(t.amount), 0)::float AS avg_tip_amount,
      COALESCE(MAX(t.amount), 0)::float AS max_tip_amount,
      COALESCE(MIN(t.amount), 0)::float AS min_tip_amount,
      COUNT(DISTINCT t."fromUserId")::int AS unique_supporters_count
    FROM "Creator" c
    LEFT JOIN "Tip" t ON t."creatorId" = c.id AND t.status = 'confirmed'
    GROUP BY c.id, c."userId", c.username, c."totalEarnings", c."pendingBalance";
  `,
  DAILY_EARNINGS: `
    CREATE OR REPLACE VIEW daily_earnings_view AS
    SELECT
      "creatorId" AS creator_id,
      DATE_TRUNC('day', "createdAt")::date AS date,
      COUNT(*)::int AS tip_count,
      COALESCE(SUM(amount), 0)::float AS daily_earnings,
      COALESCE(AVG(amount), 0)::float AS avg_amount
    FROM "Tip"
    WHERE status = 'confirmed'
    GROUP BY "creatorId", DATE_TRUNC('day', "createdAt")::date;
  `,
  TOP_SUPPORTERS: `
    CREATE OR REPLACE VIEW top_supporters_view AS
    SELECT
      t."creatorId" AS creator_id,
      t."fromUserId" AS user_id,
      u.name AS user_name,
      u.email AS user_email,
      COUNT(t.id)::int AS tip_count,
      COALESCE(SUM(t.amount), 0)::float AS total_amount,
      MAX(t."createdAt") AS last_tip_date
    FROM "Tip" t
    JOIN "User" u ON u.id = t."fromUserId"
    WHERE t.status = 'confirmed'
    GROUP BY t."creatorId", t."fromUserId", u.name, u.email;
  `,
} as const;

export interface CreatorAnalyticsSummaryViewRow {
  creator_id: string;
  user_id: string;
  username: string;
  total_earnings_stored: number;
  pending_balance: number;
  total_confirmed_tips: number;
  total_earnings: number;
  avg_tip_amount: number;
  max_tip_amount: number;
  min_tip_amount: number;
  unique_supporters_count: number;
}

export interface DailyEarningsViewRow {
  creator_id: string;
  date: string | Date;
  tip_count: number;
  daily_earnings: number;
  avg_amount: number;
}

export interface TopSupporterViewRow {
  creator_id: string;
  user_id: string;
  user_name: string | null;
  user_email: string;
  tip_count: number;
  total_amount: number;
  last_tip_date: string | Date;
}

/**
 * Initialize all database views for complex queries & analytics
 */
export async function initializeDatabaseViews(pool: Pool): Promise<void> {
  try {
    for (const [name, ddl] of Object.entries(DATABASE_VIEWS)) {
      await pool.query(ddl);
      logger.info({ view: name }, 'Database view initialized/updated');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to initialize database views');
    throw error;
  }
}
