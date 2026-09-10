/**
 * Stellar SDK Type Definitions
 * Provides proper TypeScript interfaces for Stellar SDK types that have loose typing
 * Used throughout the stellar client, transactions, listener, and wallet modules
 */

/**
 * Horizon Server instance type
 * Represents connection to Stellar Horizon API
 */
export interface HorizonServer {
  loadAccount(publicKey: string): Promise<StellarAccount>;
  accounts(): any;
  transactions(): any;
  payments(): any;
  ledgers(): any;
  submitTransaction(transactionXdr: string): Promise<SubmitTransactionResponse>;
}

/**
 * Stellar Account object returned from Horizon
 * Contains account details and sequence number needed for signing transactions
 */
export interface StellarAccount {
  id: string;
  account_id: string;
  sequence: string;
  balances: AccountBalance[];
  subentry_count: number;
  last_modified_ledger: number;
  last_modified_time: string;
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
  };
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  signers: Array<{
    public_key: string;
    weight: number;
    type: string;
  }>;
}

/**
 * Account balance entry from Horizon
 * Represents an asset balance held by an account
 */
export interface AccountBalance {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  last_modified_ledger?: number;
  is_clawback_enabled?: boolean;
}

/**
 * Transaction response from Horizon
 * Contains transaction details and operation results
 */
export interface TransactionResponse {
  id: string;
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  source_account_sequence: string;
  fee_charged: number;
  max_fee: number;
  operation_count: number;
  transaction_successful: boolean;
  result_code: string;
  result_xdr: string;
  envelope_xdr: string;
  signatures: string[];
  memo_type: string;
  memo?: string;
  links: {
    self: { href: string };
    transactions: { href: string };
    operations: { href: string };
    effects: { href: string };
    precedes: { href: string };
    succeeds: { href: string };
  };
}

/**
 * Response from submitting a transaction to Horizon
 */
export interface SubmitTransactionResponse {
  id: string;
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  source_account_sequence: string;
  fee_charged: number;
  max_fee: number;
  operation_count: number;
  transaction_successful: boolean;
  result_code?: string;
  result_xdr?: string;
  envelope_xdr: string;
  signatures: string[];
}

/**
 * Ledger response from Horizon
 * Contains network-wide ledger information including base fees
 */
export interface LedgerResponse {
  id: string;
  paging_token: string;
  sequence: number;
  hash: string;
  prev_hash: string;
  timestamp: string;
  transaction_count: number;
  operation_count: number;
  closed_at: string;
  total_coins: string;
  fee_pool: string;
  base_fees_in_stroops: number;
  base_reserves_in_stroops: number;
  max_tx_set_size: number;
  protocol_version: number;
  header_xdr: string;
}

/**
 * Network status information
 * Used for retrieving current network fees and ledger details
 */
export interface NetworkStatus {
  baseFee: number;
  ledgerVersion: number;
  baseReserve?: number;
  maxTxSetSize?: number;
}

/**
 * Payment record from Horizon
 * Represents a payment operation in a transaction
 */
export interface PaymentRecord {
  id: string;
  paging_token: string;
  transaction_hash: string;
  type: string;
  type_i: number;
  created_at: string;
  source_account: string;
  from: string;
  to: string;
  amount: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

/**
 * Stream event for transaction confirmations
 * Represents a single event from the Horizon stream
 */
export interface StreamEvent<T> {
  id: string;
  paging_token: string;
  created_at: string;
  data: T;
}

/**
 * Stream error event
 */
export interface StreamError {
  status: number;
  statusText: string;
  detail?: string;
  extras?: {
    result_codes?: {
      transaction?: string;
      operations?: string[];
    };
  };
}

/**
 * Fee statistics from Horizon
 * Used to calculate recommended transaction fees
 */
export interface FeeStatistics {
  last_ledger: number;
  last_ledger_base_fee: number;
  ledger_capacity_usage: number;
  max_fee: {
    p10: number;
    p20: number;
    p30: number;
    p40: number;
    p50: number;
    p60: number;
    p70: number;
    p80: number;
    p90: number;
    p99: number;
  };
}

/**
 * Operation record from Horizon
 * Base type for all operation types
 */
export interface OperationRecord {
  id: string;
  paging_token: string;
  transaction_hash: string;
  type: string;
  type_i: number;
  created_at: string;
  source_account: string;
  transaction_successful: boolean;
}

/**
 * Payment operation record
 */
export interface PaymentOperationRecord extends OperationRecord {
  type: 'payment';
  from: string;
  to: string;
  amount: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

/**
 * Wallet balance information
 * Aggregated balance data for a Stellar account
 */
export interface WalletBalance {
  lumens: string;
  usdc?: string;
  [key: string]: string | undefined;
}

/**
 * Transaction building parameters
 * Input for buildPaymentTransaction function
 */
export interface TransactionBuildParams {
  senderPublicKey: string;
  recipientPublicKey: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
}

/**
 * Signed transaction envelope
 * Output from transaction signing
 */
export interface SignedTransactionEnvelope {
  transactionHash: string;
  transactionEnvelope: string;
  fee: number;
}
