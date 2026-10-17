import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { hashPassword } from '../../utils/password';
import { UserRole } from '../../utils/roles';

export interface FlagWalletRequest {
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  notes?: string;
}

export interface FreezeAccountRequest {
  reason: string;
  duration?: number; // In hours, null = indefinite
  notes?: string;
}

export class AdminService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /** Verify a bounded batch and return an item-level result for each ID. */
  async bulkVerifyCreators(adminUserId: string, creatorIds: string[]): Promise<{
    total: number;
    succeeded: number;
    failed: number;
    results: Array<{ creatorId: string; success: boolean; reason?: string }>;
  }> {
    if (!(await this.isAdmin(adminUserId))) throw new UnauthorizedError('Only admins can verify creators');
    if (creatorIds.length === 0 || creatorIds.length > 100) {
      throw new ValidationError('creatorIds must contain between 1 and 100 items');
    }
    const results = await Promise.all(creatorIds.map(async (creatorId) => {
      const creator = await this.prisma.creator.findUnique({ where: { id: creatorId }, select: { id: true } });
      if (!creator) return { creatorId, success: false, reason: 'Creator not found' };
      await this.prisma.creator.update({ where: { id: creatorId }, data: { verified: true } });
      return { creatorId, success: true };
    }));
    const succeeded = results.filter((result) => result.success).length;
    return { total: results.length, succeeded, failed: results.length - succeeded, results };
  }

  /**
   * Parse CSV text into header + rows. Supports quoted fields with embedded commas.
   */
  private static parseCsv(csvText: string): { headers: string[]; rows: Record<string, string>[] } {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    let i = 0;

    const pushField = () => {
      fields.push(current);
      current = '';
    };

    while (i < csvText.length) {
      const char = csvText[i];
      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < csvText.length && csvText[i + 1] === '"') {
            current += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          current += char;
          i++;
        }
      } else if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ',') {
        pushField();
        i++;
      } else if (char === '\r') {
        i++;
      } else if (char === '\n') {
        pushField();
        i++;
      } else {
        current += char;
        i++;
      }
    }
    if (current !== '' || fields.length > 0) pushField();

    // Re-parse line-oriented for correctness with quoted newlines handled above
    const lines: string[] = [];
    current = '';
    inQuotes = false;
    i = 0;
    while (i < csvText.length) {
      const char = csvText[i];
      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < csvText.length && csvText[i + 1] === '"') {
            current += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          current += char;
          i++;
        }
      } else if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === '\r') {
        i++;
      } else if (char === '\n') {
        lines.push(current);
        current = '';
        i++;
      } else {
        current += char;
        i++;
      }
    }
    if (current !== '' || lines.length > 0) lines.push(current);

    const nonEmptyLines = lines.filter((line) => line.trim() !== '');
    if (nonEmptyLines.length === 0) {
      return { headers: [], rows: [] };
    }

    const splitLine = (line: string): string[] => {
      const vals: string[] = [];
      let val = '';
      inQuotes = false;
      for (let j = 0; j < line.length; j++) {
        const c = line[j];
        if (inQuotes) {
          if (c === '"') {
            if (j + 1 < line.length && line[j + 1] === '"') {
              val += '"';
              j++;
            } else {
              inQuotes = false;
            }
          } else {
            val += c;
          }
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          vals.push(val);
          val = '';
        } else {
          val += c;
        }
      }
      vals.push(val);
      return vals;
    };

    const headers = splitLine(nonEmptyLines[0]).map((h) => h.trim());
    const rows: Record<string, string>[] = [];
    for (let k = 1; k < nonEmptyLines.length; k++) {
      const values = splitLine(nonEmptyLines[k]);
      const row: Record<string, string> = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] !== undefined ? values[idx] : '';
      });
      rows.push(row);
    }

    return { headers, rows };
  }

  /**
   * Bulk import users from CSV. Validates all rows before creating any user.
   * Creates users in a single transaction; rolls back on any error.
   */
  async bulkImportUsers(adminUserId: string, csvText: string): Promise<{
    total: number;
    created: number;
    failed: number;
    results: Array<{
      row: number;
      email: string;
      status: 'created' | 'failed';
      userId?: string;
      errors?: string[];
    }>;
  }> {
    if (!(await this.isAdmin(adminUserId))) {
      throw new UnauthorizedError('Only admins can bulk import users');
    }

    const { headers, rows } = AdminService.parseCsv(csvText);

    if (rows.length === 0) {
      throw new ValidationError('CSV contains no data rows');
    }

    const requiredHeaders = ['email', 'password'];
    const missingHeaders = requiredHeaders.filter((h) => !headers.includes(h));
    if (missingHeaders.length > 0) {
      throw new ValidationError(`Missing required CSV columns: ${missingHeaders.join(', ')}`);
    }

    const validRoles = ['fan', 'creator', 'admin'];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Phase 1: validate all rows before creating any user (fail-fast)
    const rowErrors = new Map<number, string[]>();
    const seenEmails = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // header is row 1, data is 1-indexed
      const errors: string[] = [];

      const email = (row.email || '').trim();
      const password = (row.password || '').trim();
      const role = ((row.role || 'fan').trim() || 'fan') as string;

      if (!email) {
        errors.push('Email is required');
      } else if (!emailRegex.test(email)) {
        errors.push('Invalid email format');
      } else if (seenEmails.has(email)) {
        errors.push('Duplicate email in CSV');
      } else {
        seenEmails.add(email);
        const existing = await this.prisma.user.findUnique({ where: { email } });
        if (existing) {
          errors.push('Email already registered');
        }
      }

      if (!password) {
        errors.push('Password is required');
      } else if (password.length < 8) {
        errors.push('Password must be at least 8 characters');
      } else if (password.length > 128) {
        errors.push('Password must be at most 128 characters');
      }

      if (role && !validRoles.includes(role)) {
        errors.push("Invalid role (must be 'fan', 'creator', or 'admin')");
      }

      if (errors.length > 0) {
        rowErrors.set(rowNum, errors);
      }
    }

    if (rowErrors.size > 0) {
      const details: Record<string, unknown> = {};
      rows.forEach((row, i) => {
        const rowNum = i + 2;
        const errors = rowErrors.get(rowNum);
        if (errors) {
          details[rowNum] = {
            email: (row.email || '').trim(),
            errors,
          };
        }
      });
      throw new ValidationError('One or more rows contain invalid data', { details });
    }

    // Phase 2: create all users in a transaction; rollback on any error
    const results = await this.prisma.$transaction(async (tx) => {
      const createdResults: Array<{
        row: number;
        email: string;
        status: 'created' | 'failed';
        userId?: string;
        errors?: string[];
      }> = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;
        const hashedPassword = await hashPassword((row.password || '').trim());
        const user = await tx.user.create({
          data: {
            email: (row.email || '').trim(),
            password: hashedPassword,
            name: (row.name || '').trim() || null,
            role: ((row.role || 'fan').trim() || 'fan') as string,
          },
        });
        createdResults.push({
          row: rowNum,
          email: (row.email || '').trim(),
          status: 'created' as const,
          userId: user.id,
        });
      }

      return createdResults;
    });

    const created = results.filter((r) => r.status === 'created').length;

    logger.info(`Bulk user import by admin ${adminUserId}: ${created}/${rows.length} created`);

    return {
      total: rows.length,
      created,
      failed: rows.length - created,
      results,
    };
  }

  /**
   * Check if user is admin
   */
  private async isAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === UserRole.ADMIN;
  }

  /**
   * Flag a wallet as suspicious
   */
  async flagWallet(
    adminUserId: string,
    walletAddress: string,
    data: FlagWalletRequest
  ): Promise<{
    id: string;
    walletAddress: string;
    flaggedAt: string;
    reason: string;
    severity: string;
  }> {
    return this.executeWithLogging('admin.flagWallet', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can flag wallets');
      }

      // Create wallet flag
      const flag = await this.prisma.walletFlag.create({
        data: {
          address: walletAddress,
          reason: data.reason,
          severity: data.severity,
          notes: data.notes,
          flaggedBy: adminUserId,
        },
      });

      logger.warn(`Wallet flagged by admin: ${walletAddress} (severity: ${data.severity})`);

      return {
        id: flag.id,
        walletAddress,
        flaggedAt: flag.createdAt.toISOString(),
        reason: flag.reason,
        severity: flag.severity,
      };
    });
  }

  /**
   * Unflag a wallet
   */
  async unflagWallet(adminUserId: string, flagId: string): Promise<void> {
    return this.executeWithLogging('admin.unflagWallet', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can unflag wallets');
      }

      const flag = await this.prisma.walletFlag.findUnique({
        where: { id: flagId },
      });

      if (!flag) {
        throw new NotFoundError('Wallet flag');
      }

      await this.prisma.walletFlag.delete({
        where: { id: flagId },
      });

      logger.info(`Wallet flag resolved by admin: ${flagId}`);
    });
  }

  /**
   * Freeze a creator account pending review
   */
  async freezeAccount(
    adminUserId: string,
    creatorId: string,
    data: FreezeAccountRequest
  ): Promise<{
    id: string;
    creatorId: string;
    frozenAt: string;
    reason: string;
    expiresAt?: string;
  }> {
    return this.executeWithLogging('admin.freezeAccount', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can freeze accounts');
      }

      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      // Calculate expiration time if duration provided
      let expiresAt = null;
      if (data.duration) {
        expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + data.duration);
      }

      // Create freeze record
      const freeze = await this.prisma.accountFreeze.create({
        data: {
          creatorId,
          reason: data.reason,
          duration: data.duration || null,
          expiresAt,
          notes: data.notes,
          frozenBy: adminUserId,
        },
      });

      logger.warn(`Creator account frozen by admin: ${creatorId} (reason: ${data.reason})`);

      return {
        id: freeze.id,
        creatorId,
        frozenAt: freeze.createdAt.toISOString(),
        reason: freeze.reason,
        expiresAt: expiresAt?.toISOString(),
      };
    });
  }

  /**
   * Unfreeze a creator account
   */
  async unfreezeAccount(adminUserId: string, freezeId: string): Promise<void> {
    return this.executeWithLogging('admin.unfreezeAccount', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can unfreeze accounts');
      }

      const freeze = await this.prisma.accountFreeze.findUnique({
        where: { id: freezeId },
      });

      if (!freeze) {
        throw new NotFoundError('Account freeze');
      }

      await this.prisma.accountFreeze.delete({
        where: { id: freezeId },
      });

      logger.info(`Creator account unfrozen by admin: ${freeze.creatorId}`);
    });
  }

  /**
   * Get moderation queue - flagged wallets and frozen accounts with pagination
   */
  async getModerationQueue(
    page: number = 1,
    pageSize: number = 20
  ): Promise<{
    flaggedWallets: {
      id: string;
      address: string;
      severity: string;
      reason: string;
      flaggedAt: string;
    }[];
    frozenAccounts: {
      id: string;
      creatorId: string;
      reason: string;
      frozenAt: string;
      expiresAt?: string;
    }[];
    totalWallets: number;
    totalFreezes: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  }> {
    return this.executeWithLogging('admin.moderationQueue', async () => {
      const { sanitizePageNumber, sanitizePageSize } = await import('../../utils/pagination');

      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, 20);
      const skip = (safePage - 1) * safePageSize;

      const [flaggedWallets, totalWallets, frozenAccounts, totalFreezes] = await Promise.all([
        this.prisma.walletFlag.findMany({
          where: { resolved: false },
          orderBy: { createdAt: 'desc' },
          skip,
          take: safePageSize,
        }),
        this.prisma.walletFlag.count({ where: { resolved: false } }),
        this.prisma.accountFreeze.findMany({
          where: { resolved: false },
          orderBy: { createdAt: 'desc' },
          skip,
          take: safePageSize,
        }),
        this.prisma.accountFreeze.count({ where: { resolved: false } }),
      ]);

      const maxTotal = Math.max(totalWallets, totalFreezes);
      const totalPages = Math.ceil(maxTotal / safePageSize) || 1;

      return {
        flaggedWallets: flaggedWallets.map((f) => ({
          id: f.id,
          address: f.address,
          severity: f.severity,
          reason: f.reason,
          flaggedAt: f.createdAt.toISOString(),
        })),
        frozenAccounts: frozenAccounts.map((f) => ({
          id: f.id,
          creatorId: f.creatorId,
          reason: f.reason,
          frozenAt: f.createdAt.toISOString(),
          expiresAt: f.expiresAt?.toISOString(),
        })),
        totalWallets,
        totalFreezes,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      };
    });
  }

  /**
   * Check if wallet is flagged (used for payment validation)
   */
  async isWalletFlagged(walletAddress: string): Promise<boolean> {
    const flag = await this.prisma.walletFlag.findFirst({
      where: {
        address: walletAddress,
        resolved: false,
      },
    });
    return !!flag;
  }

  /**
   * Check if creator account is frozen (used for payment validation)
   */
  async isAccountFrozen(creatorId: string): Promise<boolean> {
    const freeze = await this.prisma.accountFreeze.findFirst({
      where: {
        creatorId,
        resolved: false,
      },
    });

    // Check if freeze has expired
    if (freeze && freeze.expiresAt && freeze.expiresAt < new Date()) {
      // Auto-resolve expired freeze
      await this.prisma.accountFreeze.update({
        where: { id: freeze.id },
        data: { resolved: true, resolvedAt: new Date() },
      });
      return false;
    }

    return !!freeze;
  }
}
