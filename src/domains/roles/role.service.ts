import { PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../utils/errors';

export class RoleService {
  constructor(private readonly prisma: PrismaClient) {}
  async ensureDefaults() {
    for (const role of [{ name: 'admin', hierarchy: 100 }, { name: 'moderator', hierarchy: 75 }, { name: 'creator', hierarchy: 50 }, { name: 'user', hierarchy: 10 }]) {
      await this.prisma.role.upsert({ where: { name: role.name }, create: role, update: { hierarchy: role.hierarchy } });
    }
  }
  async list() { return this.prisma.role.findMany({ orderBy: [{ hierarchy: 'desc' }, { name: 'asc' }], include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } } }); }
  async create(actorId: string, input: { name: string; description?: string; hierarchy?: number }) {
    const name = input.name.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,49}$/.test(name)) throw new ValidationError('Role name must be 2-50 characters');
    const role = await this.prisma.role.create({ data: { name, description: input.description, hierarchy: input.hierarchy ?? 0 } });
    await this.audit(actorId, role.id, 'role.created', { name }); return role;
  }
  async createPermission(input: { name: string; description?: string; resource: string; action: string }) { return this.prisma.permission.create({ data: { ...input, name: input.name.trim().toLowerCase() } }); }
  async assignPermission(actorId: string, roleId: string, permissionId: string) {
    const result = await this.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId } }, create: { roleId, permissionId }, update: {} });
    await this.audit(actorId, roleId, 'permission.assigned', { permissionId }); return result;
  }
  async assignRole(actorId: string, userId: string, roleId: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } }); if (!role) throw new NotFoundError('Role');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }); if (!user) throw new NotFoundError('User');
    const result = await this.prisma.userRole.upsert({ where: { userId_roleId: { userId, roleId } }, create: { userId, roleId, assignedBy: actorId }, update: { assignedBy: actorId } });
    await this.audit(actorId, roleId, 'user.role_assigned', { userId }); return result;
  }
  async hasPermission(userId: string, permissionName: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, userRoles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
    if (!user) return false; if (user.role.toLowerCase() === 'admin') return true;
    return user.userRoles.some(({ role }) => role.permissions.some(({ permission }) => permission.name === permissionName));
  }
  private audit(actorId: string, roleId: string | null, action: string, details: Record<string, unknown>) { return this.prisma.roleChange.create({ data: { actorId, roleId, action, details: details as any } }); }
}
