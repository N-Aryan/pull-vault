import Decimal from "decimal.js";

/**
 * Money is *always* stored and transmitted as an integer number of cents
 * (BIGINT in Postgres, number in JS as long as < Number.MAX_SAFE_INTEGER ≈ $90T).
 *
 * Arithmetic that involves percentages (fees, EV, weighted draws) is done with
 * decimal.js to avoid floating-point error, then rounded back to integer cents.
 */

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export const cents = (dollars: number | string) =>
  new Decimal(dollars).mul(100).round().toNumber();

export const dollars = (c: number) => new Decimal(c).div(100).toFixed(2);

export const formatUSD = (c: number) => `$${dollars(c)}`;

/** Apply a fee (basis points) to an amount in cents and return [net, fee]. */
export function applyFeeBps(amountCents: number, bps: number): [number, number] {
  const fee = new Decimal(amountCents).mul(bps).div(10_000).round().toNumber();
  return [amountCents - fee, fee];
}

export const FEES = {
  TRADE_BPS: 500, // 5% — taken from seller's proceeds on marketplace sale
  AUCTION_BPS: 800, // 8% — taken from final hammer price
  MIN_BID_INC_BPS: 500, // bid must exceed current by at least 5% (or $1, whichever is higher)
  MIN_BID_INC_FLOOR_CENTS: 100,
} as const;

export function minNextBidCents(currentBidCents: number): number {
  const pct = new Decimal(currentBidCents).mul(FEES.MIN_BID_INC_BPS).div(10_000).round().toNumber();
  return currentBidCents + Math.max(pct, FEES.MIN_BID_INC_FLOOR_CENTS);
}
