/**
 * Build a display index from a backend chain-verification report.
 *
 * A ledger value or missing result is never a spendable/displayable balance.
 * A numeric zero is accepted only when the backend explicitly marks the
 * corresponding on-chain observation verified.
 */
export function indexVerifiedBalances(report) {
  const index = new Map();
  const assets = Array.isArray(report?.assets) ? report.assets : [];
  for (const asset of assets) {
    if (!asset || asset.verified !== true || asset.available_balance == null) continue;
    const symbol = String(asset.asset || "").trim().toUpperCase();
    const balance = Number(asset.available_balance);
    if (!symbol || !Number.isFinite(balance) || balance < 0) continue;
    index.set(symbol, Object.freeze({ ...asset, available_balance: balance }));
  }
  return index;
}

export function getVerifiedAvailableBalance(report, symbol) {
  const key = String(symbol || "").trim().toUpperCase();
  if (!key) return null;
  const record = indexVerifiedBalances(report).get(key);
  return record ? record.available_balance : null;
}
