import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { CreateCreatorRequest, UpdateCreatorRequest } from './creator.types';
import { ValidationError } from '../../utils/errors';
import { getOrFetch, invalidate, update, createCacheKey, CacheType } from '../../lib/cache/cache-aside';

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
      });

      if (existingCreator) {
        throw new ValidationError('Username already taken');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
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
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                },
              },
            },
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
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                },
              },
            },
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
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
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
      const { sanitizePageNumber, sanitizePageSize, parseSortParameters } = await import('../../utils/pagination');

      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, 20);

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
          skip,
          take: safePageSize,
          orderBy,
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
              },
            },
          },
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
