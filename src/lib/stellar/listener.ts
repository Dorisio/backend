import { PrismaClient } from '@prisma/client';
import { getStellarClient } from './client';
import { logger } from '../../utils/logger';
import { config } from '../../config/env';

export interface TransactionListener {
  tipId: string;
  transactionHash: string;
  onConfirmed: (result: any) => void;
  onFailed: (error: any) => void;
}

/**
 * Poll for transaction confirmation on Horizon
 * Checks periodically if a transaction has been confirmed on the Stellar network
 *
 * @param transactionHash Transaction to monitor
 * @param maxAttempts Maximum polling attempts (default 60 = ~60 seconds at 1s interval)
 * @param pollIntervalMs Interval between polls in milliseconds (default 1000)
 * @returns Confirmation status with transaction details if confirmed
 */
export async function pollForTransactionConfirmation(
  transactionHash: string,
  maxAttempts: number = 60,
  pollIntervalMs: number = 1000
): Promise<{
  confirmed: boolean;
  result?: any;
  error?: string;
}> {
  try {
    logger.debug(
      `Starting transaction confirmation polling: ${transactionHash} (max ${maxAttempts} attempts)`
    );

    const client = getStellarClient();
    const server = client.getServer();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const transaction = await server.transactions().hash(transactionHash).call();

        if (transaction) {
          logger.info(
            `Transaction confirmed: ${transactionHash} at ledger ${transaction.ledger} (attempt ${attempt + 1}/${maxAttempts})`
          );
          return {
            confirmed: true,
            result: transaction,
          };
        }
      } catch (error: any) {
        if (error.status !== 404) {
          // 404 is expected while transaction is pending
          logger.error(
            `Unexpected error polling transaction ${transactionHash}:`,
            error
          );
          throw error;
        }

        // 404 means transaction not yet confirmed, continue polling
        logger.debug(
          `Transaction not yet confirmed (attempt ${attempt + 1}/${maxAttempts})`
        );
      }

      // Wait before next poll (except on last attempt)
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    logger.warn(
      `Transaction confirmation timeout after ${maxAttempts} attempts: ${transactionHash}`
    );
    return {
      confirmed: false,
      error: `Transaction not confirmed after ${maxAttempts} polling attempts`,
    };
  } catch (error) {
    logger.error(`Failed to poll for transaction confirmation: ${transactionHash}`, error);
    throw error;
  }
}

/**
 * Update tip status based on transaction confirmation
 * Used to transition tip from pending to completed/failed based on network confirmation
 *
 * @param prisma Prisma client instance
 * @param tipId Tip to update
 * @param transactionHash Transaction hash to verify
 * @returns Updated tip or throws on error
 */
export async function updateTipStatusFromTransaction(
  prisma: PrismaClient,
  tipId: string,
  transactionHash: string
): Promise<void> {
  try {
    logger.debug(
      `Updating tip status based on transaction confirmation: ${tipId} (${transactionHash})`
    );

    // Poll for transaction confirmation
    const confirmationResult = await pollForTransactionConfirmation(transactionHash);

    if (confirmationResult.confirmed && confirmationResult.result) {
      // Transaction is confirmed on the network - update tip to completed
      const tip = await prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        logger.warn(`Tip not found when updating from transaction: ${tipId}`);
        return;
      }

      // Only update if still pending
      if (tip.status !== 'pending') {
        logger.debug(`Tip already has status ${tip.status}, skipping update`);
        return;
      }

      // Update tip to completed
      await prisma.tip.update({
        where: { id: tipId },
        data: {
          status: 'completed',
        },
      });

      // Update creator earnings
      await prisma.creator.update({
        where: { id: tip.creatorId },
        data: {
          totalEarnings: {
            increment: tip.amount,
          },
          pendingBalance: {
            increment: tip.amount,
          },
        },
      });

      logger.info(
        `Tip confirmed and completed: ${tipId}, creator earnings updated by ${tip.amount}`
      );
    } else {
      // Transaction failed or timed out
      const tip = await prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        logger.warn(`Tip not found when marking as failed: ${tipId}`);
        return;
      }

      // Only mark as failed if still pending
      if (tip.status === 'pending') {
        await prisma.tip.update({
          where: { id: tipId },
          data: {
            status: 'failed',
          },
        });

        logger.warn(
          `Tip marked as failed: ${tipId}, reason: ${confirmationResult.error}`
        );
      }
    }
  } catch (error) {
    logger.error(`Failed to update tip status from transaction: ${tipId}`, error);

    // Attempt to mark as failed to prevent hanging pending status
    try {
      const tip = await prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (tip && tip.status === 'pending') {
        await prisma.tip.update({
          where: { id: tipId },
          data: {
            status: 'failed',
          },
        });

        logger.warn(`Tip marked as failed due to error: ${tipId}`);
      }
    } catch (updateError) {
      logger.error(`Failed to mark tip as failed: ${tipId}`, updateError);
    }
  }
}

/**
 * Stream and process transactions for a creator account
 * Used to detect incoming USDC payments to a creator's wallet
 * Updates corresponding tips in real-time when payments are detected
 *
 * @param prisma Prisma client instance
 * @param creatorPublicKey Creator's Stellar public key
 * @param targetAssetCode Optional: only process payments for this asset (e.g., 'USDC')
 * @returns Function to close the stream
 */
export async function streamCreatorPayments(
  prisma: PrismaClient,
  creatorPublicKey: string,
  targetAssetCode?: string
): Promise<() => void> {
  try {
    logger.debug(
      `Starting payment stream for creator: ${creatorPublicKey}${targetAssetCode ? ` (asset: ${targetAssetCode})` : ''}`
    );

    const client = getStellarClient();
    const server = client.getServer();

    const closeStream = await server
      .payments()
      .forAccount(creatorPublicKey)
      .stream({
        onmessage: async (payment: any) => {
          try {
            // Filter for payments (not other operations)
            if (payment.type !== 'payment') {
              return;
            }

            // Filter for target asset if specified
            if (targetAssetCode && payment.asset_code !== targetAssetCode) {
              return;
            }

            logger.debug(
              `Received payment for creator: ${creatorPublicKey}, tx: ${payment.transaction_hash}, amount: ${payment.amount}`
            );

            // Find matching tip by transaction hash
            const tip = await prisma.tip.findFirst({
              where: {
                transactionHash: payment.transaction_hash,
                status: 'pending',
              },
            });

            if (tip) {
              logger.info(`Confirming tip from payment stream: ${tip.id}`);

              // Update tip to completed
              await prisma.tip.update({
                where: { id: tip.id },
                data: {
                  status: 'completed',
                },
              });

              // Update creator earnings
              await prisma.creator.update({
                where: { id: tip.creatorId },
                data: {
                  totalEarnings: {
                    increment: tip.amount,
                  },
                  pendingBalance: {
                    increment: tip.amount,
                  },
                },
              });

              logger.info(
                `Tip auto-confirmed from payment stream: ${tip.id}, amount: ${tip.amount}`
              );
            } else {
              logger.debug(
                `No matching pending tip found for payment: ${payment.transaction_hash}`
              );
            }
          } catch (error) {
            logger.error('Error processing payment from stream:', error);
          }
        },

        onerror: (error: any) => {
          logger.error(`Payment stream error for creator ${creatorPublicKey}:`, error);
        },
      });

    logger.info(`Payment stream started for creator: ${creatorPublicKey}`);
    return closeStream;
  } catch (error) {
    logger.error(
      `Failed to start payment stream for creator: ${creatorPublicKey}`,
      error
    );
    throw error;
  }
}

/**
 * Background job to process pending tips
 * Polls Horizon for confirmation of pending transactions
 * Call this periodically (e.g., every 30 seconds) to confirm pending tips
 *
 * @param prisma Prisma client instance
 * @returns Number of tips processed
 */
export async function processPendingTips(prisma: PrismaClient): Promise<number> {
  try {
    logger.debug('Processing pending tips');

    // Find all pending tips with transaction hashes
    const pendingTips = await prisma.tip.findMany({
      where: {
        status: 'pending',
        transactionHash: {
          not: null,
        },
      },
      take: 50, // Process up to 50 at a time to avoid overload
    });

    logger.debug(`Found ${pendingTips.length} pending tips to process`);

    let confirmed = 0;
    let failed = 0;

    // Process each tip
    for (const tip of pendingTips) {
      if (tip.transactionHash) {
        try {
          const confirmationResult = await pollForTransactionConfirmation(
            tip.transactionHash,
            5, // Fewer attempts for background job (5 seconds)
            500 // Shorter interval (500ms)
          );

          if (confirmationResult.confirmed && confirmationResult.result) {
            // Update tip to completed
            await prisma.tip.update({
              where: { id: tip.id },
              data: {
                status: 'completed',
              },
            });

            // Update creator earnings
            await prisma.creator.update({
              where: { id: tip.creatorId },
              data: {
                totalEarnings: {
                  increment: tip.amount,
                },
                pendingBalance: {
                  increment: tip.amount,
                },
              },
            });

            confirmed++;
            logger.info(`Confirmed pending tip: ${tip.id}`);
          } else {
            // Check if too much time has passed (give up after 5 minutes)
            const ageMs = Date.now() - tip.createdAt.getTime();
            if (ageMs > 5 * 60 * 1000) {
              // Mark as failed if over 5 minutes old
              await prisma.tip.update({
                where: { id: tip.id },
                data: {
                  status: 'failed',
                },
              });

              failed++;
              logger.warn(
                `Gave up on pending tip after 5 minutes: ${tip.id}`
              );
            }
          }
        } catch (error) {
          logger.error(`Error processing pending tip ${tip.id}:`, error);
        }
      }
    }

    logger.info(
      `Finished processing pending tips: ${confirmed} confirmed, ${failed} failed, ${pendingTips.length - confirmed - failed} still pending`
    );

    return confirmed + failed;
  } catch (error) {
    logger.error('Failed to process pending tips:', error);
    return 0;
  }
}

/**
 * Initialize background job for confirming pending tips
 * Starts a periodic job that runs every 30 seconds
 *
 * @param prisma Prisma client instance
 * @returns Function to cancel the interval
 */
export function startPendingTipConfirmationJob(prisma: PrismaClient): () => void {
  logger.info('Starting background job: pending tip confirmation (every 30 seconds)');

  const intervalId = setInterval(async () => {
    try {
      await processPendingTips(prisma);
    } catch (error) {
      logger.error('Error in pending tip confirmation job:', error);
    }
  }, 30 * 1000); // Run every 30 seconds

  // Return function to cancel
  return () => {
    clearInterval(intervalId);
    logger.info('Stopped pending tip confirmation job');
  };
}
