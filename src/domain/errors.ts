// Rule violations of the domain. They carry a stable code; the use cases decide what each one means for a caller.
export type DomainErrorCode =
  // Input that breaks a rule of its own (the use cases answer 400).
  | "invalid_amount"
  | "invalid_side"
  | "invalid_price"
  | "invalid_shares"
  | "invalid_offers"
  | "invalid_market_id"
  | "invalid_user_id"
  | "invalid_tenant_id"
  | "invalid_outcome"
  | "crossed_offers"
  // A valid request that the current state refuses (the use cases answer 409).
  | "insufficient_credits"
  | "insufficient_liquidity"
  | "insufficient_holdings"
  | "price_limit_exceeded"
  // Sales (UC-08): the trader holds fewer shares than it sells; the proceeds would be below minProceedsMicro or zero.
  | "insufficient_shares"
  | "proceeds_below_minimum"
  | "market_not_open"
  | "market_closed"
  // A number left the range of exact integers, or an event would make a balance or a holding negative. Both mean a bug
  // or corrupt data: the transaction is refused and nothing is written.
  | "amount_out_of_range"
  | "invariant_violated";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly field?: string,
    /** Machine-readable facts for the caller, for example the largest amount the offers can fill. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
