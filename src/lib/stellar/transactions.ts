import * as StellarSdk from '@stellar/stellar-sdk';
import { getStellarClient } from './client';
import { logger } from '../../utils/logger';

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
 * Returns an unsigned transaction that can be signed by the client wallet (Freighter)
 *
 * @param data Payment details including sender, recipient, amount, and asset info
 * @returns TransactionBuilder instance ready to be built and signed
 */
export async function buildPaymentTransaction(data: PaymentTransactionData): Promise<any> {
  try {
    const client = getStellarClient();
    const server = client.getServer();
    const networkPassphrase = client.getNetworkPassphrase();

    logger.debug(
      `Building payment transaction: ${data.senderPublicKey} -> ${data.recipientPublicKey}, amount: ${data.amount}`
    );

    // Validate public keys
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(data.senderPublicKey)) {
      throw new Error('Invalid sender public key format');
    }
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(data.recipientPublicKey)) {
      throw new Error('Invalid recipient public key format');
    }

    // Validate amount
    const amountNum = parseFloat(data.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new Error('Amount must be a positive number');
    }

    // Get sender account to determine next sequence number
    let senderAccount;
    try {
      senderAccount = await server.loadAccount(data.senderPublicKey);
    } catch (error: any) {
      if (error.status === 404) {
        throw new Error(
          `Sender account does not exist on ${client.getNetworkType()} network`
        );
      }
      throw error;
    }

    // Build transaction
    let builder = new StellarSdk.TransactionBuilder(senderAccount, {
      fee: StellarSdk.BASE_FEE, // 100 stroops
      networkPassphrase: networkPassphrase,
      timebounds: {
        minTime: 0,
        maxTime: Math.floor(Date.now() / 1000) + 5 * 60, // 5 minute validity window
      },
    });

    // Add payment operation
    if (data.assetCode && data.assetIssuer) {
      // Custom asset (e.g., USDC)
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(data.assetIssuer)) {
        throw new Error('Invalid asset issuer public key format');
      }

      const asset = new StellarSdk.Asset(data.assetCode, data.assetIssuer);
      builder = builder.addOperation(
        StellarSdk.Operation.payment({
          destination: data.recipientPublicKey,
          asset: asset,
          amount: data.amount,
        })
      );

      logger.debug(
        `Added payment operation: ${data.amount} ${data.assetCode} (${data.assetIssuer})`
      );
    } else {
      // Native lumens (XLM)
      builder = builder.addOperation(
        StellarSdk.Operation.payment({
          destination: data.recipientPublicKey,
          asset: StellarSdk.Asset.native(),
          amount: data.amount,
        })
      );

      logger.debug(`Added payment operation: ${data.amount} XLM (native)`);
    }

    // Add memo if provided (typically tip ID or reference)
    if (data.memo) {
      if (data.memo.length > 28) {
        throw new Error('Memo text must be 28 characters or less');
      }
      builder = builder.addMemo(StellarSdk.Memo.text(data.memo));
      logger.debug(`Added memo: ${data.memo}`);
    }

    const transaction = builder.build();

    logger.info(
      `Payment transaction built successfully for tip: ${data.memo || 'no-memo'}`
    );
    return transaction;
  } catch (error) {
    logger.error('Failed to build payment transaction:', error);
    throw error;
  }
}

/**
 * Build a challenge transaction for wallet verification (SEP-10 style)
 * User will sign this with their Freighter wallet to prove ownership
 *
 * @param clientPublicKey The user's public key
 * @param nonce Random nonce for this verification attempt
 * @returns Transaction XDR string for user to sign
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
      throw new Error('Server keypair not configured - wallet verification unavailable');
    }

    logger.debug(`Building challenge transaction for wallet verification: ${clientPublicKey}`);

    // Validate client public key
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(clientPublicKey)) {
      throw new Error('Invalid client public key format');
    }

    // Get server account to determine sequence number
    const serverAccount = await server.loadAccount(serverKeypair.publicKey());

    // Build challenge transaction
    const transaction = new StellarSdk.TransactionBuilder(serverAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: networkPassphrase,
      timebounds: {
        minTime: 0,
        maxTime: Math.floor(Date.now() / 1000) + 5 * 60, // 5 minute validity window
      },
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: 'challenge',
          value: Buffer.from(nonce).toString('base64') as any as string,
        })
      )
      .build();

    // Sign with server key
    transaction.sign(serverKeypair);

    const transactionEnvelope = transaction.toEnvelope().toXDR() as any;

    logger.debug('Challenge transaction built and signed by server');
    return transactionEnvelope;
  } catch (error) {
    logger.error('Failed to build challenge transaction:', error);
    throw error;
  }
}

/**
 * Verify a signed challenge transaction
 * Ensures the user signed it with their private key
 *
 * @param transactionEnvelope Signed transaction XDR from user wallet
 * @param clientPublicKey The user's public key
 * @param nonce The nonce used in the challenge
 * @returns True if signature is valid, false otherwise
 */
export async function verifyChallengeTransaction(
  transactionEnvelope: string,
  clientPublicKey: string,
  _nonce: string
): Promise<boolean> {
  try {
    logger.debug(`Verifying challenge transaction for wallet: ${clientPublicKey}`);

    // Validate public key format
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(clientPublicKey)) {
      throw new Error('Invalid client public key format');
    }

    // Parse transaction envelope
    let transaction;
    try {
      transaction = (StellarSdk as any).TransactionEnvelope.fromXDR(
        transactionEnvelope,
        'base64'
      );
    } catch (error) {
      logger.warn('Failed to parse transaction XDR');
      return false;
    }

    const txBase = transaction.tx;

    // Check if client signed the transaction
    const signatures = transaction.signatures();
    let clientSigned = false;

    for (const signature of signatures) {
      try {
        const keypair = StellarSdk.Keypair.fromPublicKey(clientPublicKey);
        const signatureBuffer = signature.signature();

        // Verify the signature against the transaction hash
        const verified = keypair.verify(txBase.hash(), signatureBuffer);
        if (verified) {
          clientSigned = true;
          logger.debug('Client signature verified successfully');
          break;
        }
      } catch (error) {
        // Continue to next signature
        logger.debug('Signature verification attempt failed, trying next signature');
      }
    }

    if (!clientSigned) {
      logger.warn(`Client signature not found or invalid for: ${clientPublicKey}`);
      return false;
    }

    logger.info('Challenge transaction verified successfully');
    return true;
  } catch (error) {
    logger.error('Failed to verify challenge transaction:', error);
    throw error;
  }
}

/**
 * Submit a signed payment transaction to the Stellar network
 * Transaction must be signed by the sender before submission
 *
 * @param transactionEnvelope Signed transaction XDR from user wallet
 * @returns Transaction details including hash and envelope
 */
export async function submitSignedTransaction(
  transactionEnvelope: string
): Promise<SignedTransaction> {
  try {
    const client = getStellarClient();

    logger.debug('Submitting signed transaction to Stellar network');

    // Validate XDR format
    if (!transactionEnvelope || typeof transactionEnvelope !== 'string') {
      throw new Error('Invalid transaction envelope format');
    }

    // Submit to network
    const result = await client.submitTransaction(transactionEnvelope);

    // Extract relevant fields
    const signedTx: SignedTransaction = {
      transactionHash: result.id,
      transactionEnvelope: transactionEnvelope,
      fee: parseInt(result.fees?.max_fee || result.fees || '100'),
    };

    logger.info(`Transaction submitted successfully: ${result.id}`);
    return signedTx;
  } catch (error: any) {
    logger.error('Failed to submit signed transaction:', error);

    // Provide more helpful error messages
    if (error.response?.status === 400) {
      const resultCodes = error.response.data?.extras?.result_codes;
      if (resultCodes) {
        logger.error('Transaction validation error:', resultCodes);
        throw new Error(`Transaction validation failed: ${JSON.stringify(resultCodes)}`);
      }
    }

    throw error;
  }
}

/**
 * Check transaction status on the network
 * Polls Horizon to see if transaction has been confirmed
 *
 * @param transactionHash Transaction hash to check
 * @returns Confirmation status and transaction details if available
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
    if (error.message && error.message.includes('not yet confirmed')) {
      logger.debug(`Transaction not yet confirmed: ${transactionHash}`);
      return {
        confirmed: false,
      };
    }

    logger.error(`Failed to check transaction status: ${transactionHash}`, error);
    throw error;
  }
}

/**
 * Stream account payments for real-time payment detection
 * Useful for detecting incoming tips to creator wallets
 *
 * @param publicKey Account to monitor
 * @param onPayment Callback for each payment detected
 * @param onError Optional error callback
 * @returns Function to close the stream
 */
export async function streamAccountPayments(
  publicKey: string,
  onPayment: (payment: any) => void,
  onError?: (error: any) => void
): Promise<() => void> {
  try {
    const client = getStellarClient();
    const server = client.getServer();

    logger.debug(`Starting payment stream for account: ${publicKey}`);

    const closeStream = await server.payments().forAccount(publicKey).stream({
      onmessage: onPayment,
      onerror: onError || ((error: any) => logger.error('Payment stream error:', error)),
    });

    return closeStream;
  } catch (error) {
    logger.error(`Failed to start payment stream for ${publicKey}:`, error);
    throw error;
  }
}
