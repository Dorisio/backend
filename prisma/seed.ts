import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const roles = [
  { name: 'admin', description: 'Platform administrator', hierarchy: 100 },
  { name: 'moderator', description: 'Trust and safety moderator', hierarchy: 75 },
  { name: 'creator', description: 'Creator account', hierarchy: 50 },
  { name: 'user', description: 'Standard user account', hierarchy: 10 },
] as const;

const adminPermissions = [
  { name: 'users:read', description: 'View user accounts', resource: 'users', action: 'read' },
  {
    name: 'users:manage',
    description: 'Manage user accounts',
    resource: 'users',
    action: 'manage',
  },
  {
    name: 'moderation:manage',
    description: 'Manage moderation actions',
    resource: 'moderation',
    action: 'manage',
  },
  { name: 'audit:read', description: 'Read audit events', resource: 'audit', action: 'read' },
] as const;

async function main(): Promise<void> {
  const defaultAssets = [
    { code: 'XLM', issuer: null, name: 'Stellar Lumens', decimals: 7, priority: 10 },
    { code: 'USDC', issuer: process.env.USDC_ISSUER ?? null, name: 'USD Coin', decimals: 7, priority: 20 },
  ] as const;
  for (const asset of defaultAssets) {
    await prisma.stellarAsset.upsert({
      where: { code_issuer: { code: asset.code, issuer: asset.issuer } },
      create: asset,
      update: { name: asset.name, decimals: asset.decimals, priority: asset.priority, enabled: true },
    });
  }

  const roleRecords = new Map<string, { id: string }>();

  for (const role of roles) {
    const record = await prisma.role.upsert({
      where: { name: role.name },
      create: role,
      update: role,
      select: { id: true },
    });
    roleRecords.set(role.name, record);
  }

  const admin = roleRecords.get('admin');
  if (!admin) throw new Error('Admin role was not created');

  for (const permission of adminPermissions) {
    const record = await prisma.permission.upsert({
      where: { name: permission.name },
      create: permission,
      update: permission,
      select: { id: true },
    });

    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: admin.id, permissionId: record.id } },
      create: { roleId: admin.id, permissionId: record.id },
      update: {},
    });
  }

  console.log(`Seeded ${roles.length} roles, ${adminPermissions.length} admin permissions, and ${defaultAssets.length} assets.`);
}

main()
  .catch((error) => {
    console.error('Database seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
