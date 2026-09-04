import { PrismaClient } from '@prisma/client';
import * as StellarSdk from '@stellar/stellar-sdk';
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

/**
 * In-memory store for nonces
 * In production, consider using Redis or database for persistence across restarts
 * Each nonce is tied to a specific public key and expires after WALLET_NONCE_EXPIRY seconds
 */
const nonceStore = new Map<string, WalletNonce>();

/**
 * Generate a nonce for wallet linking challenge
 * Nonce is a random 32-byte hex string that the user must sign with their wallet
 *
 * @param publicKey User's Stellar public key
 * @returns Nonce string to be used in challenge transaction
 */
export async function generateWalletNonce(publicKey: string): Promise<string> {
  try {
    // Validate Stellar public key format
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      logger.warn(`Invalid Stellar public key format: ${publicKey}`);
      throw new Error('Invalid Stellar public key format');
    }

    logger.debug(`Generating wallet nonce for: ${publicKey}`);

    // Generate random 32-byte nonce
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + config.WALLET_NONCE_EXPIRY * 1000;

    // Store nonce with expiration
    nonceStore.set(nonce, {
      nonce,
      publicKey,
      expiresAt,
    });

    // Clean up expired nonces periodically
    cleanupExpiredNonces();

    logger.debug(
      `Nonce generated successfully for ${publicKey}: ${nonce.substring(0, 8)}...`
    );

    return nonce;
  } catch (error) {
    logger.error('Failed to generate wallet nonce:', error);
    throw error;
  }
}

/**
 * Get challenge transaction for wallet verification
 * User will sign this transaction with their Freighter wallet
 *
 * @param nonce Nonce returned from generateWalletNonce
 * @returns Challenge transaction XDR for user to sign
 */
export async function getWalletChallenge(nonce: string): Promise<string> {
  try {
    const storedNonce = nonceStore.get(nonce);

    if (!storedNonce) {
      logger.warn(`Nonce not found: ${nonce.substring(0, 8)}...`);
      throw new Error('Nonce not found or already used');
    }

    // Check if nonce has expired
    if (storedNonce.expiresAt < Date.now()) {
      logger.warn(`Nonce expired: ${nonce.substring(0, 8)}...`);
      nonceStore.delete(nonce);
      throw new Error('Nonce has expired. Please generate a new one.');
    }

    logger.debug(`Building challenge for nonce: ${nonce.substring(0, 8)}...`);

    const client = getStellarClient();
    const serverKeypair = client.getServerKeypair();

    if (!serverKeypair) {
      logger.error('Server keypair not configured for wallet verification');
      throw new Error('Wallet verification service is not available');
    }

    // Build and sign challenge transaction
    const challengeTransaction = await buildChallengeTransaction(
      storedNonce.publicKey,
      nonce
    );

    logger.debug(`Challenge transaction built for nonce: ${nonce.substring(0, 8)}...`);

    return challengeTransaction;
  } catch (error) {
    logger.error('Failed to get wallet challenge:', error);
    throw error;
  }
}

/**
 * Verify signed challenge and link wallet to user
 * This implements the challenge-response flow:
 * 1. User requests nonce
 * 2. User signs challenge with their wallet
 * 3. Backend verifies signature and links wallet to user
 *
 * @param prisma Prisma client
 * @param userId User ID to link wallet to
 * @param publicKey User's Stellar public key
 * @param nonce Original nonce used in challenge
 * @param signedTransaction Signed transaction from user's wallet
 * @returns Created/updated wallet record
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
    logger.debug(
      `Verifying and linking wallet: ${publicKey} to user: ${userId}`
    );

    // Step 1: Validate nonce
    const storedNonce = nonceStore.get(nonce);

    if (!storedNonce) {
      logger.warn(`Nonce not found for wallet verification: ${nonce.substring(0, 8)}...`);
      throw new Error('Nonce not found or already used');
    }

    if (storedNonce.expiresAt < Date.now()) {
      logger.warn(`Nonce expired for wallet verification: ${nonce.substring(0, 8)}...`);
      nonceStore.delete(nonce);
      throw new Error('Nonce has expired. Please start over with a new nonce.');
    }

    // Step 2: Verify public key matches
    if (storedNonce.publicKey !== publicKey) {
      logger.warn(
        `Public key mismatch: expected ${storedNonce.publicKey}, got ${publicKey}`
      );
      throw new Error('Public key does not match nonce');
    }

    // Step 3: Verify signature
    logger.debug('Verifying wallet signature...');
    const isValid = await verifyChallengeTransaction(signedTransaction, publicKey, nonce);

    if (!isValid) {
      logger.warn(
        `Invalid signature for wallet verification: ${publicKey}`
      );
      throw new Error('Invalid wallet signature. Please sign with your wallet and try again.');
    }

    logger.debug('Wallet signature verified successfully');

    // Step 4: Check if account exists on Stellar network
    logger.debug(`Checking if wallet account exists on network: ${publicKey}`);
    const client = getStellarClient();
    const accountExists = await client.accountExists(publicKey);

    if (!accountExists) {
      logger.warn(
        `Wallet account does not exist on ${client.getNetworkType()} network: ${publicKey}`
      );
      throw new Error(
        `Wallet account does not exist on the ${client.getNetworkType()} Stellar network. Please fund your account first.`
      );
    }

    logger.debug('Wallet account verified on network');

    // Step 5: Check if wallet already exists
    let wallet = await prisma.wallet.findUnique({
      where: { publicKey },
    });

    if (wallet) {
      // Wallet already exists - verify it belongs to this user
      if (wallet.userId !== userId) {
        logger.warn(
          `Wallet already linked to different user: ${publicKey} (existing: ${wallet.userId}, requested: ${userId})`
        );
        throw new Error('This wallet is already linked to another account');
      }

      // Update existing wallet to verified
      wallet = await prisma.wallet.update({
        where: { publicKey },
        data: {
          verified: true,
        },
      });

      logger.info(`Existing wallet updated to verified: ${publicKey} for user: ${userId}`);
    } else {
      // Create new wallet record
      wallet = await prisma.wallet.create({
        data: {
          userId,
          publicKey,
          verified: true,
        },
      });

      logger.info(`New wallet created and verified: ${publicKey} for user: ${userId}`);
    }

    // Step 6: Clean up nonce (one-time use)
    nonceStore.delete(nonce);

    logger.info(
      `Wallet successfully verified and linked: ${publicKey} -> user ${userId}`
    );

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
 * Returns only verified wallets that can be used for sending tips
 *
 * @param prisma Prisma client
 * @param userId User ID
 * @returns Array of verified wallet records
 */
export async function getUserWallets(
  prisma: PrismaClient,
  userId: string
): Promise<
  {
    id: string;
    publicKey: string;
    name: string | null;
    verified: boolean;
    createdAt: Date;
  }[]
> {
  try {
    logger.debug(`Fetching verified wallets for user: ${userId}`);

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
      orderBy: {
        createdAt: 'desc',
      },
    });

    logger.debug(`Found ${wallets.length} verified wallets for user: ${userId}`);

    return wallets;
  } catch (error) {
    logger.error(`Failed to fetch wallets for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Unlink wallet from user
 * User can remove a wallet they've previously linked
 *
 * @param prisma Prisma client
 * @param userId User ID (for authorization)
 * @param walletId Wallet ID to remove
 */
export async function unlinkWallet(
  prisma: PrismaClient,
  userId: string,
  walletId: string
): Promise<void> {
  try {
    logger.debug(`Unlinking wallet: ${walletId} from user: ${userId}`);

    // Verify wallet exists and belongs to user
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      logger.warn(`Wallet not found for unlinking: ${walletId}`);
      throw new Error('Wallet not found');
    }

    if (wallet.userId !== userId) {
      logger.warn(
        `Unauthorized wallet unlink attempt: wallet ${walletId} belongs to ${wallet.userId}, not ${userId}`
      );
      throw new Error('Wallet does not belong to this user');
    }

    // Delete wallet
    await prisma.wallet.delete({
      where: { id: walletId },
    });

    logger.info(
      `Wallet unlinked successfully: ${wallet.publicKey} from user: ${userId}`
    );
  } catch (error) {
    logger.error(`Failed to unlink wallet: ${walletId}`, error);
    throw error;
  }
}

/**
 * Get wallet balance for a verified wallet
 * Returns balances for native lumens (XLM) and USDC if available
 *
 * @param publicKey Stellar public key
 * @returns Object with lumens and optional USDC balances
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

    // Extract relevant balances
    for (const balance of balances) {
      if (balance.asset_type === 'native') {
        result.lumens = balance.balance;
      } else if (balance.asset_code === 'USDC' && config.USDC_ISSUER) {
        if (balance.asset_issuer === config.USDC_ISSUER) {
          result.usdc = balance.balance;
        }
      }
    }

    logger.debug(
      `Wallet balances fetched: ${publicKey} - XLM: ${result.lumens}${result.usdc ? `, USDC: ${result.usdc}` : ''}`
    );

    return result;
  } catch (error) {
    logger.error(`Failed to fetch balance for wallet ${publicKey}:`, error);
    throw error;
  }
}

/**
 * Update wallet name (optional metadata)
 *
 * @param prisma Prisma client
 * @param userId User ID (for authorization)
 * @param walletId Wallet ID to update
 * @param name New name for wallet (e.g., "Main Wallet", "Trading Account")
 */
export async function updateWalletName(
  prisma: PrismaClient,
  userId: string,
  walletId: string,
  name: string
): Promise<{ id: string; publicKey: string; name: string }> {
  try {
    logger.debug(`Updating wallet name: ${walletId} to "${name}"`);

    // Verify wallet exists and belongs to user
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new Error('Wallet not found');
    }

    if (wallet.userId !== userId) {
      logger.warn(
        `Unauthorized wallet update attempt: wallet ${walletId} belongs to ${wallet.userId}, not ${userId}`
      );
      throw new Error('Wallet does not belong to this user');
    }

    // Update name
    const updated = await prisma.wallet.update({
      where: { id: walletId },
      data: { name },
    });

    logger.info(`Wallet name updated: ${walletId} -> "${name}"`);

    return {
      id: updated.id,
      publicKey: updated.publicKey,
      name: updated.name || '',
    };
  } catch (error) {
    logger.error(`Failed to update wallet name: ${walletId}`, error);
    throw error;
  }
}

/**
 * Clean up expired nonces from memory
 * Called periodically to prevent memory leaks
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
    logger.debug(`Cleaned up ${cleaned} expired wallet nonces`);
  }
}

/**
 * Periodic cleanup job for expired nonces
 * Runs every 5 minutes
 *
 * @returns Function to cancel the cleanup job
 */
export function startNonceCleanupJob(): () => void {
  logger.info('Starting background job: wallet nonce cleanup (every 5 minutes)');

  const intervalId = setInterval(() => {
    try {
      cleanupExpiredNonces();
    } catch (error) {
      logger.error('Error in nonce cleanup job:', error);
    }
  }, 5 * 60 * 1000); // Run every 5 minutes

  return () => {
    clearInterval(intervalId);
    logger.info('Stopped nonce cleanup job');
  };
}
