/** Supported display and settlement currencies for multi-currency tips. */
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'XLM', 'USDC'] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export interface ExchangeRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  capturedAt: string;
}

export function assertCurrency(code: string): asserts code is CurrencyCode {
  if (!SUPPORTED_CURRENCIES.includes(code as CurrencyCode)) {
    throw new Error(`Unsupported currency: ${code}`);
  }
}

export function convertAmount(amount: number, rate: ExchangeRate): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Amount must be a non-negative number');
  if (!Number.isFinite(rate.rate) || rate.rate <= 0) throw new Error('Exchange rate must be positive');
  assertCurrency(rate.base);
  assertCurrency(rate.quote);
  return Math.round(amount * rate.rate * 100) / 100;
}

export function validateExchangeRate(rate: ExchangeRate): void {
  assertCurrency(rate.base);
  assertCurrency(rate.quote);
  if (rate.base === rate.quote && rate.rate !== 1) throw new Error('Same-currency rate must equal 1');
  if (!Number.isFinite(rate.rate) || rate.rate <= 0) throw new Error('Exchange rate must be positive');
  if (!Number.isFinite(Date.parse(rate.capturedAt))) throw new Error('Invalid exchange-rate timestamp');
}
