import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

/**
 * Stellar Client for interacting with the Stellar network
 * Handles:
 * - Testnet/Mainnet/Standalone network configuration
 * - Account loading and balance queries
 * - Transaction submission and monitoring
 * - Payment streaming
 */
export class StellarClient {
  private server: any; // Use any type for Server due to SDK typing issues
  private networkPassphrase: string;
  private serverKeypair: StellarSdk.Keypair | null = null;
  private networkType: 'testnet' | 'mainnet' | 'standalone';

  constructor() {
    this.networkType = config.STELLAR_NETWORK as 'testnet' | 'mainnet' | 'standalone';

    // Initialize Horizon server based on network
    this.server = this.initializeServer();

    // Set network passphrase
    this.networkPassphrase = this.getNetworkPassphrase();

    // Initialize server keypair if secret key is provided
    this.serverKeypair = this.initializeServerKeypair();

    logger.info(
      `Stellar client initialized: network=${this.networkType}, horizon=${config.STELLAR_HORIZON_URL}`
    );
  }

  /**
   * Initialize Horizon server for the specified network
   */
  private initializeServer(): any {
    const horizonUrl = config.STELLAR_HORIZON_URL;

    try {
      const server = new (StellarSdk as any).Server(horizonUrl, {
        allowHttp: horizonUrl.startsWith('http://'),
      });

      logger.debug(`Stellar Horizon server initialized at ${horizonUrl}`);
      return server;
    } catch (error) {
      logger.error('Failed to initialize Stellar Horizon server:', error);
      throw new Error('Failed to initialize Stellar client');
    }
  }

  /**
   * Get network passphrase based on STELLAR_NETWORK config
   */
  private getNetworkPassphrase(): string {
    const passphrases: Record<string, string> = {
      testnet: (StellarSdk.Networks as any).TESTNET_NETWORK_PASSPHRASE,
      mainnet: (StellarSdk.Networks as any).PUBLIC_NETWORK_PASSPHRASE,
      standalone: (StellarSdk.Networks as any).STANDALONE_NETWORK_PASSPHRASE,
    };

    const passphrase = passphrases[this.networkType];
    if (!passphrase) {
      throw new Error(`Unknown Stellar network: ${this.networkType}`);
    }

    logger.debug(`Using network passphrase for: ${this.networkType}`);
    return passphrase;
  }

  /**
   * Initialize server keypair from STELLAR_SERVER_SECRET_KEY
   * Used for signing challenge transactions during wallet verification
   */
  private initializeServerKeypair(): StellarSdk.Keypair | null {
    if (!config.STELLAR_SERVER_SECRET_KEY) {
      logger.warn('STELLAR_SERVER_SECRET_KEY not configured - wallet verification disabled');
      return null;
    }

    try {
      const keypair = StellarSdk.Keypair.fromSecret(config.STELLAR_SERVER_SECRET_KEY);
      logger.info(`Stellar server keypair initialized: ${keypair.publicKey()}`);
      return keypair;
    } catch (error) {
      logger.error('Failed to initialize server keypair from secret key:', error);
      throw new Error('Invalid STELLAR_SERVER_SECRET_KEY format');
    }
  }

  /**
   * Get the Horizon server instance
   */
  getServer(): any {
    return this.server;
  }

  /**
   * Get the network passphrase for transaction signing
   */
  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /**
   * Get the server keypair (for signing challenge transactions)
   */
  getServerKeypair(): StellarSdk.Keypair | null {
    return this.serverKeypair;
  }

  /**
   * Get the current network type (testnet/mainnet/standalone)
   */
  getNetworkType(): string {
    return this.networkType;
  }

  /**
   * Get account details from Horizon
   */
  async getAccount(publicKey: string): Promise<any> {
    try {
      logger.debug(`Fetching account from Horizon: ${publicKey}`);
      const account = await this.server.loadAccount(publicKey);
      return account;
    } catch (error: any) {
      if (error.status === 404) {
        logger.warn(`Account not found on network: ${publicKey}`);
        throw new Error(`Account ${publicKey} does not exist on the network`);
      }
      logger.error(`Failed to fetch account ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Get account balances from Horizon
   */
  async getAccountBalances(publicKey: string): Promise<any[]> {
    try {
      logger.debug(`Fetching balances for account: ${publicKey}`);
      const account = await this.server.accounts().accountId(publicKey).call();
      return account.balances;
    } catch (error: any) {
      if (error.status === 404) {
        logger.warn(`Account not found: ${publicKey}`);
        throw new Error(`Account ${publicKey} does not exist on the network`);
      }
      logger.error(`Failed to fetch balances for ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Check if account exists on the network
   */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      logger.debug(`Checking if account exists: ${publicKey}`);
      await this.server.loadAccount(publicKey);
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      logger.error(`Error checking account existence for ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Get transaction by hash from Horizon
   */
  async getTransaction(transactionHash: string): Promise<any> {
    try {
      logger.debug(`Fetching transaction: ${transactionHash}`);
      const transaction = await this.server.transactions().hash(transactionHash).call();
      return transaction;
    } catch (error: any) {
      if (error.status === 404) {
        logger.debug(`Transaction not found (not yet confirmed): ${transactionHash}`);
        throw new Error('Transaction not yet confirmed on network');
      }
      logger.error(`Failed to fetch transaction ${transactionHash}:`, error);
      throw error;
    }
  }

  /**
   * Stream transactions for an account (for real-time updates)
   */
  async streamAccountTransactions(
    publicKey: string,
    onMessage: (transaction: any) => void,
    onError?: (error: any) => void
  ): Promise<() => void> {
    try {
      logger.debug(`Starting transaction stream for account: ${publicKey}`);
      const closeStream = await this.server.transactions().forAccount(publicKey).stream({
        onmessage: onMessage,
        onerror: onError || ((error: any) => logger.error('Transaction stream error:', error)),
      });

      return closeStream;
    } catch (error) {
      logger.error(`Failed to start transaction stream for ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Get latest transactions for an account
   */
  async getAccountTransactions(
    publicKey: string,
    limit: number = 10,
    order: 'asc' | 'desc' = 'desc'
  ): Promise<any[]> {
    try {
      logger.debug(
        `Fetching ${limit} transactions for account (${order}): ${publicKey}`
      );
      const transactions = await this.server
        .transactions()
        .forAccount(publicKey)
        .limit(limit)
        .order(order)
        .call();

      return transactions.records;
    } catch (error) {
      logger.error(`Failed to fetch transactions for ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Get latest payments for an account
   */
  async getAccountPayments(
    publicKey: string,
    limit: number = 10,
    order: 'asc' | 'desc' = 'desc'
  ): Promise<any[]> {
    try {
      logger.debug(`Fetching ${limit} payments for account (${order}): ${publicKey}`);
      const payments = await this.server
        .payments()
        .forAccount(publicKey)
        .limit(limit)
        .order(order)
        .call();

      return payments.records;
    } catch (error) {
      logger.error(`Failed to fetch payments for ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Submit a signed transaction to the network
   */
  async submitTransaction(transactionXdr: string): Promise<any> {
    try {
      logger.debug('Submitting transaction to Horizon network');
      const result = await this.server.submitTransaction(transactionXdr);
      logger.info(`Transaction submitted successfully: ${result.id}`);
      return result;
    } catch (error: any) {
      logger.error('Failed to submit transaction:', error);
      
      // Provide more helpful error message for common cases
      if (error.response?.data?.extras?.result_codes) {
        const resultCodes = error.response.data.extras.result_codes;
        logger.error('Transaction result codes:', resultCodes);
      }
      
      throw error;
    }
  }

  /**
   * Get network status and fees
   */
  async getNetworkStatus(): Promise<{ baseFee: number; ledgerVersion: number }> {
    try {
      const ledger = await this.server.ledgers().order('desc').limit(1).call();
      return {
        baseFee: ledger.records[0]?.base_fees_in_stroops || 100,
        ledgerVersion: ledger.records[0]?.sequence || 0,
      };
    } catch (error) {
      logger.error('Failed to fetch network status:', error);
      throw error;
    }
  }
}

/**
 * Singleton instance of StellarClient
 * Ensures only one connection to Horizon per process
 */
let stellarClient: StellarClient | null = null;

/**
 * Get or create the singleton Stellar client instance
 */
export function getStellarClient(): StellarClient {
  if (!stellarClient) {
    try {
      stellarClient = new StellarClient();
    } catch (error) {
      logger.error('Failed to create Stellar client:', error);
      throw error;
    }
  }
  return stellarClient;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetStellarClient(): void {
  stellarClient = null;
  logger.debug('Stellar client instance reset');
}
