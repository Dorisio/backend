import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export class StellarClient {
  private server: any; // Use any type for Server due to SDK typing issues
  private networkPassphrase: string;
  private serverKeypair: StellarSdk.Keypair | null = null;

  constructor() {
    // Initialize Horizon server
    this.server = new (StellarSdk as any).Server(config.STELLAR_HORIZON_URL);

    // Set network passphrase based on environment
    if (config.STELLAR_NETWORK === 'mainnet') {
      this.networkPassphrase = (StellarSdk.Networks as any).PUBLIC_NETWORK_PASSPHRASE;
    } else if (config.STELLAR_NETWORK === 'standalone') {
      this.networkPassphrase = (StellarSdk.Networks as any).STANDALONE_NETWORK_PASSPHRASE;
    } else {
      this.networkPassphrase = (StellarSdk.Networks as any).TESTNET_NETWORK_PASSPHRASE;
    }

    // Initialize server keypair if secret key is provided
    if (config.STELLAR_SERVER_SECRET_KEY) {
      try {
        this.serverKeypair = StellarSdk.Keypair.fromSecret(config.STELLAR_SERVER_SECRET_KEY);
        logger.info(
          `Stellar server initialized with public key: ${this.serverKeypair.publicKey()}`
        );
      } catch (error) {
        logger.error('Failed to initialize server keypair:', error);
      }
    }
  }

  getServer(): any {
    return this.server;
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  getServerKeypair(): StellarSdk.Keypair | null {
    return this.serverKeypair;
  }

  /**
   * Get account details from Horizon
   */
  async getAccount(publicKey: string): Promise<any> {
    try {
      logger.debug(`Fetching account: ${publicKey}`);
      const account = await this.server.loadAccount(publicKey);
      return account;
    } catch (error) {
      logger.error(`Failed to fetch account ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Get account balances
   */
  async getAccountBalances(publicKey: string): Promise<any[]> {
    try {
      const account = await this.server.accounts().accountId(publicKey).call();
      return account.balances;
    } catch (error) {
      logger.error(`Failed to fetch balances for ${publicKey}:`, error);
      throw error;
    }
  }

  /**
   * Check if account exists on the network
   */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.server.loadAccount(publicKey);
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(transactionHash: string): Promise<any> {
    try {
      logger.debug(`Fetching transaction: ${transactionHash}`);
      const transaction = await this.server.transactions().hash(transactionHash).call();
      return transaction;
    } catch (error) {
      logger.error(`Failed to fetch transaction ${transactionHash}:`, error);
      throw error;
    }
  }

  /**
   * Stream transactions for an account
   */
  async streamAccountTransactions(
    publicKey: string,
    onMessage: (transaction: any) => void,
    onError?: (error: any) => void
  ): Promise<() => void> {
    try {
      logger.debug(`Starting transaction stream for: ${publicKey}`);
      const closeStream = await this.server.transactions().forAccount(publicKey).stream({
        onmessage: onMessage,
        onerror: onError,
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
      logger.debug(`Fetching transactions for: ${publicKey}`);
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
   * Submit a signed transaction
   */
  async submitTransaction(transaction: string): Promise<any> {
    try {
      logger.debug('Submitting transaction to Horizon');
      const result = await this.server.submitTransaction(transaction);
      logger.info(`Transaction submitted: ${result.id}`);
      return result;
    } catch (error: any) {
      logger.error('Failed to submit transaction:', error);
      throw error;
    }
  }
}

// Singleton instance
let stellarClient: StellarClient | null = null;

export function getStellarClient(): StellarClient {
  if (!stellarClient) {
    stellarClient = new StellarClient();
  }
  return stellarClient;
}
