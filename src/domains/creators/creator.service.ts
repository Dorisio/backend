import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { CreateCreatorRequest, UpdateCreatorRequest } from './creator.types';
import { ValidationError } from '../../utils/errors';
import { getOrFetch, update, createCacheKey, CacheType } from '../../lib/cache/cache-aside';
import {
  DEFAULT_PAGE_SIZE,
  sanitizePageNumber,
  sanitizePageSize,
  parseSortParameters,
} from '../../utils/pagination';

/**
 * Columns exposed by the public creator profile. Projecting explicitly keeps
 * list/detail reads from fetching unrelated columns and bounds the joined user
 * row to what the API actually returns.
 */
const CREATOR_PROFILE_SELECT = {
  id: true,
  userId: true,
  username: true,
  displayName: true,
  bio: true,
  avatar: true,
  verified: true,
  isPublic: true,
  totalEarnings: true,
  pendingBalance: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      name: true,
    },
  },
} as const;

export class CreatorService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async createCreator(
    userId: string,
    data: CreateCreatorRequest
  ): Promise<{ id: string; username: string }> {
    return this.executeWithLogging('creator.create', async () => {
      const existingCreator = await this.prisma.creator.findUnique({
        where: { username: data.username },
        select: { id: true },
      });

      if (existingCreator) {
        throw new ValidationError('Username already taken');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!user) {
        throw new ValidationError('User not found');
      }

      const creator = await this.prisma.creator.create({
        data: {
          userId,
          username: data.username,
          displayName: data.displayName,
          bio: data.bio,
        },
      });

      // Update user role to creator
      await this.prisma.user.update({
        where: { id: userId },
        data: { role: 'creator' },
      });

      return { id: creator.id, username: creator.username };
    });
  }

  async getCreatorByUsername(username: string): Promise<any> {
    return this.executeWithLogging('creator.getByUsername', async () => {
      const cacheKey = createCacheKey(CacheType.CREATOR, `username:${username}`);

      return getOrFetch({
        key: cacheKey,
        type: CacheType.CREATOR,
        fetchFn: async () => {
          const creator = await this.prisma.creator.findUnique({
            where: { username },
            select: CREATOR_PROFILE_SELECT,
          });

          if (!creator) {
            throw new ValidationError('Creator not found');
          }

          return creator;
        },
      });
    });
  }

  async getCreatorById(creatorId: string): Promise<any> {
    return this.executeWithLogging('creator.getById', async () => {
      const cacheKey = createCacheKey(CacheType.CREATOR, creatorId);

      return getOrFetch({
        key: cacheKey,
        type: CacheType.CREATOR,
        fetchFn: async () => {
          const creator = await this.prisma.creator.findUnique({
            where: { id: creatorId },
            select: CREATOR_PROFILE_SELECT,
          });

          if (!creator) {
            throw new ValidationError('Creator not found');
          }

          return creator;
        },
      });
    });
  }

  async updateCreator(creatorId: string, data: UpdateCreatorRequest): Promise<any> {
    return this.executeWithLogging('creator.update', async () => {
      const creator = await this.prisma.creator.update({
        where: { id: creatorId },
        data: {
          displayName: data.displayName,
          bio: data.bio,
          avatar: data.avatar,
          isPublic: data.isPublic,
        },
        select: CREATOR_PROFILE_SELECT,
      });

      // Update cache for both ID and username
      const idCacheKey = createCacheKey(CacheType.CREATOR, creatorId);
      await update(idCacheKey, creator, CacheType.CREATOR);

      if (creator.username) {
        const usernameCacheKey = createCacheKey(CacheType.CREATOR, `username:${creator.username}`);
        await update(usernameCacheKey, creator, CacheType.CREATOR);
      }

      return creator;
    });
  }

  async getCreatorByUserId(userId: string): Promise<any> {
    return this.executeWithLogging('creator.getByUserId', async () => {
      const cacheKey = createCacheKey(CacheType.CREATOR, `userId:${userId}`);

      return getOrFetch({
        key: cacheKey,
        type: CacheType.CREATOR,
        fetchFn: async () => {
          const creator = await this.prisma.creator.findUnique({
            where: { userId },
            select: CREATOR_PROFILE_SELECT,
          });

          if (!creator) {
            throw new ValidationError('Creator profile not found');
          }

          return creator;
        },
      });
    });
  }

  /**
   * List public creators with offset pagination, multi-column sorting, and search filtering
   */
  async listCreators(
    page: number = 1,
    pageSize: number = 20,
    options: {
      search?: string;
      verifiedOnly?: boolean;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    } = {}
  ) {
    return this.executeWithLogging('creator.listCreators', async () => {
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, DEFAULT_PAGE_SIZE);

      const where: any = { isPublic: true };
      if (options.verifiedOnly) {
        where.verified = true;
      }
      if (options.search) {
        where.OR = [
          { username: { contains: options.search, mode: 'insensitive' } },
          { displayName: { contains: options.search, mode: 'insensitive' } },
        ];
      }

      const sortFields = parseSortParameters(
        options.sortBy,
        options.sortOrder,
        ['createdAt', 'totalEarnings', 'displayName', 'username', 'id'],
        'totalEarnings',
        'desc'
      );

      const orderBy = sortFields.map((s) => ({ [s.field]: s.direction }));
      const skip = (safePage - 1) * safePageSize;

      const [creators, total] = await Promise.all([
        this.prisma.creator.findMany({
          where,
          select: CREATOR_PROFILE_SELECT,
          skip,
          take: safePageSize,
          orderBy,
        }),
        this.prisma.creator.count({ where }),
      ]);

      const totalPages = Math.ceil(total / safePageSize);

      return {
        creators,
        items: creators,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      };
    });
  }
}
