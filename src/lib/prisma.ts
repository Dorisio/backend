import { PrismaClient } from '@prisma/client';

/** Shared client for modules that are not constructed through application bootstrap. */
export const prisma = new PrismaClient();
