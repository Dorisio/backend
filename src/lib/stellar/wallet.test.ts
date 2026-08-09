import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateWalletNonce, verifyAndLinkWallet, getUserWallets, unlinkWallet } from './wallet';

// Mock Stellar SDK with correct package name
vi.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: vi.fn((key) => key.startsWith('G')),
  },
  Keypair: {
    fromPublicKey: vi.fn(),
  },
}));

const mockPrisma = {
  wallet: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

describe('Wallet Service', () => {
  const validPublicKey = 'GBBD47AB2EB00E041B61C1B7AD184E687E24658D52EDFFDD118F5E6221D60EFF';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateWalletNonce', () => {
    it('should generate a valid nonce', async () => {
      const nonce = await generateWalletNonce(validPublicKey);

      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(0);
    });

    it('should throw error for invalid public key', async () => {
      await expect(generateWalletNonce('invalid-key')).rejects.toThrow();
    });
  });

  describe('getUserWallets', () => {
    it('should return user wallets', async () => {
      const userId = 'user-123';

      mockPrisma.wallet.findMany.mockResolvedValue([
        {
          id: 'wallet-1',
          publicKey: validPublicKey,
          verified: true,
          createdAt: new Date(),
        },
      ]);

      const wallets = await getUserWallets(mockPrisma as any, userId);

      expect(wallets).toHaveLength(1);
      expect(wallets[0].id).toBe('wallet-1');
      expect(mockPrisma.wallet.findMany).toHaveBeenCalledWith({
        where: { userId, verified: true },
        select: expect.any(Object),
      });
    });

    it('should return empty array if no wallets', async () => {
      const userId = 'user-123';

      mockPrisma.wallet.findMany.mockResolvedValue([]);

      const wallets = await getUserWallets(mockPrisma as any, userId);

      expect(wallets).toHaveLength(0);
    });
  });

  describe('unlinkWallet', () => {
    it('should unlink wallet from user', async () => {
      const userId = 'user-123';
      const walletId = 'wallet-123';

      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: walletId,
        userId,
        publicKey: validPublicKey,
      });

      mockPrisma.wallet.delete.mockResolvedValue({});

      await unlinkWallet(mockPrisma as any, userId, walletId);

      expect(mockPrisma.wallet.delete).toHaveBeenCalledWith({
        where: { id: walletId },
      });
    });

    it('should throw error if wallet not found', async () => {
      const userId = 'user-123';
      const walletId = 'wallet-123';

      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(unlinkWallet(mockPrisma as any, userId, walletId)).rejects.toThrow();
    });

    it('should throw error if wallet belongs to different user', async () => {
      const userId = 'user-123';
      const walletId = 'wallet-123';

      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: walletId,
        userId: 'different-user',
        publicKey: validPublicKey,
      });

      await expect(unlinkWallet(mockPrisma as any, userId, walletId)).rejects.toThrow();
    });
  });
});
