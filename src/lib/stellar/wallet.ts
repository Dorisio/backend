import { PrismaClient } from '@prisma/client';
import * as StellarSdk from 'stellar-sdk';
import { randomBytes } from 'crypto';
import { buildChallengeTransaction, verifyChallengeTransaction } from './transactions';
import { getStellarClient } from './client';
import { logger } from '../../utils/logger';
import { config } from '../../config/env';

export interface WalletNonce {
  nonce: string;
  publicKey: string;
  expiresAt: number;
}

// In-memory store for nonces (in production, use Redis or database)
const nonceStore = new Map<string, WalletNonce>();

/**
 * Generate a nonce for wallet linking challenge
 */
export async function generateWalletNonce(publicKey: string): Promise<string> {
  try {
    // Validate Stellar public key
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new Error('Invalid Stellar public key');
    }

    logger.debug(`Generating nonce for wallet: ${publicKey}`);

    // Generate random nonce
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + config.WALLET_NONCE_EXPIRY * 1000;

    // Store nonce
    nonceStore.set(nonce, {
      nonce,
      publicKey,
      expiresAt,
    });

    // Clean up expired nonces
    cleanupExpiredNonces();

    logger.debug(`Nonce generated: ${nonce.substring(0, 8)}...`);
    return nonce;
  } catch (error) {
    logger.error('Failed to generate wallet nonce:', error);
    throw error;
  }
}

/**
 * Get challenge transaction for wallet verification
 */
export async function getWalletChallenge(nonce: string): Promise<string> {
  try {
    const storedNonce = nonceStore.get(nonce);

    if (!storedNonce) {
      throw new Error('Nonce not found or expired');
    }

    if (storedNonce.expiresAt < Date.now()) {
      nonceStore.delete(nonce);
      throw new Error('Nonce expired');
    }

    logger.debug(`Building challenge for nonce: ${nonce.substring(0, 8)}...`);

    const client = getStellarClient();
    const serverKeypair = client.getServerKeypair();

    if (!serverKeypair) {
      throw new Error('Server keypair not configured');
    }

    // Build challenge transaction
    const challengeTransaction = await buildChallengeTransaction(storedNonce.publicKey, nonce);

    return challengeTransaction;
  } catch (error) {
    logger.error('Failed to get wallet challenge:', error);
    throw error;
  }
}

/**
 * Verify signed challenge and link wallet to user
 */
export async function verifyAndLinkWallet(
  prisma: PrismaClient,
  userId: string,
  publicKey: string,
  nonce: string,
  signedTransaction: string
): Promise<{
  id: string;
  publicKey: string;
  verified: boolean;
}> {
  try {
    logger.debug(`Verifying and linking wallet: ${publicKey}`);

    // Validate nonce
    const storedNonce = nonceStore.get(nonce);

    if (!storedNonce) {
      throw new Error('Nonce not found or expired');
    }

    if (storedNonce.expiresAt < Date.now()) {
      nonceStore.delete(nonce);
      throw new Error('Nonce expired');
    }

    if (storedNonce.publicKey !== publicKey) {
      throw new Error('Public key mismatch');
    }

    // Verify challenge was signed by the wallet
    const isValid = await verifyChallengeTransaction(signedTransaction, publicKey, nonce);

    if (!isValid) {
      logger.warn(`Invalid signature for wallet: ${publicKey}`);
      throw new Error('Invalid wallet signature');
    }

    // Check if wallet account exists on Stellar
    const client = getStellarClient();
    const accountExists = await client.accountExists(publicKey);

    if (!accountExists) {
      logger.warn(`Wallet account does not exist on Stellar: ${publicKey}`);
      throw new Error('Wallet account does not exist on Stellar network');
    }

    // Get or create wallet record
    let wallet = await prisma.wallet.findUnique({
      where: { publicKey },
    });

    if (wallet) {
      // Update existing wallet
      if (wallet.userId !== userId) {
        logger.warn(`Wallet already linked to different user: ${publicKey}`);
        throw new Error('Wallet already linked to another user');
      }

      wallet = await prisma.wallet.update({
        where: { publicKey },
        data: {
          verified: true,
        },
      });
    } else {
      // Create new wallet
      wallet = await prisma.wallet.create({
        data: {
          userId,
          publicKey,
          verified: true,
        },
      });
    }

    // Clean up nonce
    nonceStore.delete(nonce);

    logger.info(`Wallet verified and linked: ${publicKey}`);

    return {
      id: wallet.id,
      publicKey: wallet.publicKey,
      verified: wallet.verified,
    };
  } catch (error) {
    logger.error('Failed to verify and link wallet:', error);
    throw error;
  }
}

/**
 * Get user's verified wallets
 */
export async function getUserWallets(prisma: PrismaClient, userId: string): Promise<any[]> {
  try {
    logger.debug(`Fetching wallets for user: ${userId}`);

    const wallets = await prisma.wallet.findMany({
      where: {
        userId,
        verified: true,
      },
      select: {
        id: true,
        publicKey: true,
        name: true,
        verified: true,
        createdAt: true,
      },
    });

    return wallets;
  } catch (error) {
    logger.error(`Failed to fetch wallets for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Unlink wallet from user
 */
export async function unlinkWallet(
  prisma: PrismaClient,
  userId: string,
  walletId: string
): Promise<void> {
  try {
    logger.debug(`Unlinking wallet: ${walletId} from user: ${userId}`);

    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new Error('Wallet not found');
    }

    if (wallet.userId !== userId) {
      throw new Error('Wallet does not belong to user');
    }

    await prisma.wallet.delete({
      where: { id: walletId },
    });

    logger.info(`Wallet unlinked: ${walletId}`);
  } catch (error) {
    logger.error(`Failed to unlink wallet: ${walletId}`, error);
    throw error;
  }
}

/**
 * Clean up expired nonces
 */
function cleanupExpiredNonces(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, value] of nonceStore.entries()) {
    if (value.expiresAt < now) {
      nonceStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug(`Cleaned up ${cleaned} expired nonces`);
  }
}

/**
 * Get wallet balance for USDC
 */
export async function getWalletBalance(publicKey: string): Promise<{
  lumens: string;
  usdc?: string;
}> {
  try {
    logger.debug(`Fetching balance for wallet: ${publicKey}`);

    const client = getStellarClient();
    const balances = await client.getAccountBalances(publicKey);

    const result: any = {
      lumens: '0',
    };

    for (const balance of balances) {
      if (balance.asset_type === 'native') {
        result.lumens = balance.balance;
      } else if (balance.asset_code === 'USDC' && config.USDC_ISSUER) {
        if (balance.asset_issuer === config.USDC_ISSUER) {
          result.usdc = balance.balance;
        }
      }
    }

    return result;
  } catch (error) {
    logger.error(`Failed to fetch balance for wallet ${publicKey}:`, error);
    throw error;
  }
}
