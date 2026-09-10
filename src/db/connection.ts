import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

let pool: Pool | null = null;

export const initializeDatabase = async (): Promise<void> => {
  if (pool) {
    logger.warn('Database pool already initialized');
    return;
  }

  try {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
    });

    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    logger.info('Database connection successful');
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    throw error;
  }
};

export const getDatabase = (): Pool => {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
};

export const closeDatabase = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database connection closed');
  }
};
