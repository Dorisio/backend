# Multi-currency tips

The backend currency boundary is centralized in `src/lib/currency.ts`. It
validates ISO-style currency codes, rejects invalid or stale-looking rate
records, and rounds converted amounts to cents. Supported codes are USD, EUR,
GBP, JPY, XLM, and USDC.

Exchange rates must be captured with their base, quote, numeric rate, and
timestamp. Persist the original amount and currency alongside any converted
USD amount when wiring a payment provider; never overwrite the original amount
because it is needed for receipts, refunds, and audit records.
