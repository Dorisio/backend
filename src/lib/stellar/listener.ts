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
 * Poll for transaction confirmation
 * This is called after a tip is created and a payment transaction is submitted
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
    logger.debug(`Polling for transaction confirmation: ${transactionHash}`);

    const client = getStellarClient();
    const server = client.getServer();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const transaction = await server.transactions().hash(transactionHash).call();

        if (transaction) {
          logger.info(`Transaction confirmed: ${transactionHash} at ledger ${transaction.ledger}`);
          return {
            confirmed: true,
            result: transaction,
          };
        }
      } catch (error: any) {
        if (error.status !== 404) {
          throw error;
        }
        // 404 means transaction not yet confirmed, continue polling
      }

      // Wait before next poll
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    logger.warn(`Transaction not confirmed after ${maxAttempts} attempts: ${transactionHash}`);
    return {
      confirmed: false,
      error: 'Transaction confirmation timeout',
    };
  } catch (error) {
    logger.error(`Failed to poll for transaction confirmation: ${transactionHash}`, error);
    throw error;
  }
}

/**
 * Update tip status based on transaction confirmation
 */
export async function updateTipStatusFromTransaction(
  prisma: PrismaClient,
  tipId: string,
  transactionHash: string
): Promise<void> {
  try {
    logger.debug(`Updating tip status for transaction: ${transactionHash}`);

    const confirmationResult = await pollForTransactionConfirmation(transactionHash);

    if (confirmationResult.confirmed) {
      // Transaction is confirmed - update tip to completed
      await prisma.tip.update({
        where: { id: tipId },
        data: {
          status: 'completed',
        },
      });

      // Update creator earnings
      const tip = await prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (tip) {
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
      }

      logger.info(`Tip marked as completed: ${tipId}`);
    } else {
      // Transaction failed or timed out
      await prisma.tip.update({
        where: { id: tipId },
        data: {
          status: 'failed',
        },
      });

      logger.warn(`Tip marked as failed: ${tipId}`);
    }
  } catch (error) {
    logger.error(`Failed to update tip status: ${tipId}`, error);

    // Mark as failed if we can't verify
    try {
      await prisma.tip.update({
        where: { id: tipId },
        data: {
          status: 'failed',
        },
      });
    } catch (updateError) {
      logger.error(`Failed to mark tip as failed: ${tipId}`, updateError);
    }
  }
}

/**
 * Stream and process transactions for a creator account
 * Used to detect incoming USDC payments
 */
export async function streamCreatorPayments(
  prisma: PrismaClient,
  creatorPublicKey: string,
  targetAssetCode?: string
): Promise<() => void> {
  try {
    logger.debug(`Starting payment stream for creator: ${creatorPublicKey}`);

    const client = getStellarClient();
    const server = client.getServer();

    const closeStream = await server
      .payments()
      .forAccount(creatorPublicKey)
      .stream({
        onmessage: async (payment: any) => {
          try {
            logger.debug(`Received payment for creator: ${creatorPublicKey}`, payment);

            // Filter for USDC payments if asset code specified
            if (targetAssetCode && payment.asset_code !== targetAssetCode) {
              return;
            }

            // Find matching tip
            const tip = await prisma.tip.findFirst({
              where: {
                transactionHash: payment.transaction_hash,
                status: 'pending',
              },
            });

            if (tip) {
              logger.info(`Confirming tip from payment: ${tip.id}`);
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
            }
          } catch (error) {
            logger.error('Error processing creator payment:', error);
          }
        },
        onerror: (error) => {
          logger.error(`Payment stream error for creator ${creatorPublicKey}:`, error);
        },
      });

    return closeStream;
  } catch (error) {
    logger.error(`Failed to start payment stream for creator: ${creatorPublicKey}`, error);
    throw error;
  }
}

/**
 * Background job to process pending transactions
 * Call this periodically to confirm pending tips
 */
export async function processPendingTips(prisma: PrismaClient): Promise<void> {
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
    });

    logger.debug(`Found ${pendingTips.length} pending tips to process`);

    // Process each tip
    for (const tip of pendingTips) {
      if (tip.transactionHash) {
        try {
          const confirmationResult = await pollForTransactionConfirmation(
            tip.transactionHash,
            5, // Fewer attempts for background job
            500 // Shorter interval
          );

          if (confirmationResult.confirmed) {
            await prisma.tip.update({
              where: { id: tip.id },
              data: {
                status: 'completed',
              },
            });

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

            logger.info(`Confirmed pending tip: ${tip.id}`);
          }
        } catch (error) {
          logger.error(`Error processing pending tip ${tip.id}:`, error);
        }
      }
    }

    logger.debug('Finished processing pending tips');
  } catch (error) {
    logger.error('Failed to process pending tips:', error);
  }
}
