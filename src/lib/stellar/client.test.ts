import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StellarClient } from './client';
import * as StellarSdk from '@stellar/stellar-sdk';

// Mock Stellar SDK
vi.mock('stellar-sdk', () => ({
  Server: vi.fn(),
  Keypair: {
    fromSecret: vi.fn(),
  },
  Networks: {
    PUBLIC_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    TESTNET_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STANDALONE_NETWORK_PASSPHRASE: 'Standalone Network ; February 2017',
  },
}));

describe('StellarClient', () => {
  let client: StellarClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock environment variables
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_SERVER_SECRET_KEY =
      'SBFB5VXFZLMG5BQ7MFP6G7BQYQ5YQZLKQYQZLKQYQZLKQYQZLKQYQZLK';
  });

  it('should initialize with testnet configuration', () => {
    client = new StellarClient();

    expect(client.getNetworkPassphrase()).toBe('Test SDF Network ; September 2015');
  });

  it('should initialize server when secret key provided', () => {
    client = new StellarClient();

    const keypair = client.getServerKeypair();
    expect(keypair).toBeDefined();
  });

  it('should return Stellar server instance', () => {
    client = new StellarClient();

    const server = client.getServer();
    expect(server).toBeDefined();
  });

  describe('getNetworkPassphrase', () => {
    it('should return mainnet passphrase', () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      client = new StellarClient();

      expect(client.getNetworkPassphrase()).toBe('Public Global Stellar Network ; September 2015');
    });

    it('should return testnet passphrase', () => {
      process.env.STELLAR_NETWORK = 'testnet';
      client = new StellarClient();

      expect(client.getNetworkPassphrase()).toBe('Test SDF Network ; September 2015');
    });

    it('should return standalone passphrase', () => {
      process.env.STELLAR_NETWORK = 'standalone';
      client = new StellarClient();

      expect(client.getNetworkPassphrase()).toBe('Standalone Network ; February 2017');
    });
  });

  describe('accountExists', () => {
    it('should return true if account exists', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue({}),
      };

      client = new StellarClient();
      (client as any).server = mockServer;

      const exists = await client.accountExists(
        'GBBD47AB2EB00E041B61C1B7AD184E687E24658D52EDFFDD118F5E6221D60EFF'
      );

      expect(exists).toBe(true);
    });

    it('should return false if account does not exist (404)', async () => {
      const error = new Error('Not found');
      (error as any).status = 404;

      const mockServer = {
        loadAccount: vi.fn().mockRejectedValue(error),
      };

      client = new StellarClient();
      (client as any).server = mockServer;

      const exists = await client.accountExists(
        'GBBD47AB2EB00E041B61C1B7AD184E687E24658D52EDFFDD118F5E6221D60EFF'
      );

      expect(exists).toBe(false);
    });

    it('should throw error for non-404 errors', async () => {
      const error = new Error('Server error');
      (error as any).status = 500;

      const mockServer = {
        loadAccount: vi.fn().mockRejectedValue(error),
      };

      client = new StellarClient();
      (client as any).server = mockServer;

      await expect(
        client.accountExists('GBBD47AB2EB00E041B61C1B7AD184E687E24658D52EDFFDD118F5E6221D60EFF')
      ).rejects.toThrow();
    });
  });
});
