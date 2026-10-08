import { PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { isValidAssetConfiguration } from '../../lib/stellar/validation';

export interface AssetInput {
  code: string;
  issuer?: string | null;
  name: string;
  decimals?: number;
  enabled?: boolean;
  priority?: number;
  feeBps?: number;
}

export class AssetService {
  constructor(private readonly prisma: PrismaClient) {}

  async listEnabled() {
    return this.prisma.stellarAsset.findMany({ where: { enabled: true }, orderBy: [{ priority: 'desc' }, { code: 'asc' }] });
  }

  async listAll() {
    return this.prisma.stellarAsset.findMany({ orderBy: [{ priority: 'desc' }, { code: 'asc' }] });
  }

  async create(input: AssetInput) {
    const code = input.code.trim().toUpperCase();
    const issuer = input.issuer?.trim() || null;
    if (!isValidAssetConfiguration(code, issuer)) throw new ValidationError('Invalid Stellar asset code or issuer');
    if (input.decimals !== undefined && (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 7)) {
      throw new ValidationError('Asset decimals must be between 0 and 7');
    }
    return this.prisma.stellarAsset.create({ data: { code, issuer, name: input.name.trim(), decimals: input.decimals ?? 7, enabled: input.enabled ?? true, priority: input.priority ?? 0, feeBps: input.feeBps ?? 0 } });
  }

  async update(id: string, input: Partial<AssetInput>) {
    const existing = await this.prisma.stellarAsset.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Asset');
    const code = input.code?.trim().toUpperCase() ?? existing.code;
    const issuer = input.issuer === undefined ? existing.issuer : input.issuer?.trim() || null;
    if (!isValidAssetConfiguration(code, issuer)) throw new ValidationError('Invalid Stellar asset code or issuer');
    return this.prisma.stellarAsset.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name.trim() }), code, issuer, ...(input.decimals === undefined ? {} : { decimals: input.decimals }), ...(input.enabled === undefined ? {} : { enabled: input.enabled }), ...(input.priority === undefined ? {} : { priority: input.priority }), ...(input.feeBps === undefined ? {} : { feeBps: input.feeBps }) } });
  }

  async setCreatorDefault(userId: string, assetId: string) {
    const asset = await this.prisma.stellarAsset.findFirst({ where: { id: assetId, enabled: true } });
    if (!asset) throw new NotFoundError('Enabled asset');
    const creator = await this.prisma.creator.findUnique({ where: { userId }, select: { id: true } });
    if (!creator) throw new NotFoundError('Creator');
    return this.prisma.creator.update({ where: { id: creator.id }, data: { defaultAssetId: asset.id }, select: { id: true, defaultAssetId: true } });
  }
}
