import * as StellarSdk from 'stellar-sdk';
import { getStellarClient } from './client';
import { logger } from '../../utils/logger';
import { config } from '../../config/env';

export interface PaymentTransactionData {
  senderPublicKey: string;
  recipientPublicKey: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
}

export interface SignedTransaction {
  transactionHash: string;
  transactionEnvelope: string;
  fee: number;
}

/**
 * Build a payment transaction using USDC or native lumens
 */
export async function buildPaymentTransaction(
  data: PaymentTransactionData
): Promise<StellarSdk.TransactionBuilder> {
  try {
    const client = getStellarClient();
    const server = client.getServer();
    const networkPassphrase = client.getNetworkPassphrase();

    logger.debug(
      `Building payment transaction: ${data.senderPublicKey} -> ${data.recipientPublicKey}`
    );

    // Get sender account
    const senderAccount = await server.loadAccount(data.senderPublicKey);

    // Build transaction
    let builder = new StellarSdk.TransactionBuilder(senderAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: networkPassphrase,
      timebounds: {
        minTime: 0,
        maxTime: Math.floor(Date.now() / 1000) + 5 * 60, // 5 minute timeout
      },
    });

    // Add payment operation
    if (data.assetCode && data.assetIssuer) {
      // USDC or other custom asset
      const asset = new StellarSdk.Asset(data.assetCode, data.assetIssuer);
      builder = builder.addOperation(
        StellarSdk.Operation.payment({
          destination: data.recipientPublicKey,
          asset: asset,
          amount: data.amount,
        })
      );
    } else {
      // Native lumens
      builder = builder.addOperation(
        StellarSdk.Operation.payment({
          destination: data.recipientPublicKey,
          asset: StellarSdk.Asset.native(),
          amount: data.amount,
        })
      );
    }

    // Add memo if provided
    if (data.memo) {
      builder = builder.addMemo(StellarSdk.Memo.text(data.memo));
    }

    const transaction = builder.build();

    logger.debug('Payment transaction built successfully');
    return transaction;
  } catch (error) {
    logger.error('Failed to build payment transaction:', error);
    throw error;
  }
}

/**
 * Build a challenge transaction for wallet verification (Freighter)
 */
export async function buildChallengeTransaction(
  clientPublicKey: string,
  nonce: string
): Promise<string> {
  try {
    const client = getStellarClient();
    const server = client.getServer();
    const serverKeypair = client.getServerKeypair();
    const networkPassphrase = client.getNetworkPassphrase();

    if (!serverKeypair) {
      throw new Error('Server keypair not configured');
    }

    logger.debug(`Building challenge transaction for: ${clientPublicKey}`);

    // Create a temporary account for the challenge
    const serverAccount = await server.loadAccount(serverKeypair.publicKey());

    // Build challenge transaction
    const transaction = new StellarSdk.TransactionBuilder(serverAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: networkPassphrase,
      timebounds: {
        minTime: 0,
        maxTime: Math.floor(Date.now() / 1000) + 5 * 60, // 5 minute timeout
      },
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: 'challenge',
          value: Buffer.from(nonce).toString('base64'),
        })
      )
      .build();

    // Sign with server key
    transaction.sign(serverKeypair);

    const transactionEnvelope = transaction.toEnvelope().toXDR();

    logger.debug('Challenge transaction built successfully');
    return transactionEnvelope;
  } catch (error) {
    logger.error('Failed to build challenge transaction:', error);
    throw error;
  }
}

/**
 * Verify a signed challenge transaction
 */
export async function verifyChallengeTransaction(
  transactionEnvelope: string,
  clientPublicKey: string,
  nonce: string
): Promise<boolean> {
  try {
    logger.debug(`Verifying challenge transaction for: ${clientPublicKey}`);

    // Parse transaction
    const transaction = StellarSdk.TransactionEnvelope.fromXDR(transactionEnvelope, 'base64');
    const txBase = transaction.tx;

    // Verify client signed the transaction
    const signatures = transaction.signatures();
    let clientSigned = false;

    for (const signature of signatures) {
      const keypair = StellarSdk.Keypair.fromPublicKey(clientPublicKey);
      const signatureBuffer = signature.signature();

      // Verify signature
      try {
        const verified = keypair.verify(txBase.hash(), signatureBuffer);
        if (verified) {
          clientSigned = true;
          break;
        }
      } catch (error) {
        // Continue to next signature
      }
    }

    if (!clientSigned) {
      logger.warn(`Client signature not found for: ${clientPublicKey}`);
      return false;
    }

    logger.debug('Challenge transaction verified successfully');
    return true;
  } catch (error) {
    logger.error('Failed to verify challenge transaction:', error);
    throw error;
  }
}

/**
 * Submit a signed transaction
 */
export async function submitSignedTransaction(
  transactionEnvelope: string
): Promise<SignedTransaction> {
  try {
    const client = getStellarClient();

    logger.debug('Submitting signed transaction');

    const result = await client.submitTransaction(transactionEnvelope);

    const signedTx: SignedTransaction = {
      transactionHash: result.id,
      transactionEnvelope: transactionEnvelope,
      fee: parseInt(result.fees.max_fee),
    };

    logger.info(`Transaction submitted: ${result.id}`);
    return signedTx;
  } catch (error: any) {
    logger.error('Failed to submit signed transaction:', error);
    throw error;
  }
}

/**
 * Check transaction status
 */
export async function checkTransactionStatus(transactionHash: string): Promise<{
  confirmed: boolean;
  ledger?: number;
  timestamp?: string;
  result?: any;
}> {
  try {
    const client = getStellarClient();
    const transaction = await client.getTransaction(transactionHash);

    return {
      confirmed: !!transaction,
      ledger: transaction.ledger,
      timestamp: transaction.created_at,
      result: transaction,
    };
  } catch (error: any) {
    if (error.status === 404) {
      return {
        confirmed: false,
      };
    }
    logger.error(`Failed to check transaction status: ${transactionHash}`, error);
    throw error;
  }
}

/**
 * Stream account payments (for USDC tips)
 */
export async function streamAccountPayments(
  publicKey: string,
  onPayment: (payment: any) => void,
  onError?: (error: any) => void
): Promise<() => void> {
  try {
    const client = getStellarClient();
    const server = client.getServer();

    logger.debug(`Starting payment stream for: ${publicKey}`);

    const closeStream = await server.payments().forAccount(publicKey).stream({
      onmessage: onPayment,
      onerror: onError,
    });

    return closeStream;
  } catch (error) {
    logger.error(`Failed to start payment stream for ${publicKey}:`, error);
    throw error;
  }
}
