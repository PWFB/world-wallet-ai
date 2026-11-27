export function tokenTransferIdentity(item, index = 0) {
  const txHash = String(item?.tx_hash || "").trim().toLowerCase();
  const logIndex = item?.log_index;
  if (txHash && logIndex !== null && logIndex !== undefined && String(logIndex) !== "") {
    return txHash + ":" + String(logIndex).trim().toLowerCase();
  }
  const fallback = JSON.stringify(item ?? {});
  return txHash ? txHash + ":fallback:" + fallback : "transfer:" + index + ":" + fallback;
}

export function mergeAuditPages(previous, next) {
  if (!previous || !next || Number(next.page) <= 1) return next;

  const mergeUnique = (left, right, keyOf) => {
    const seen = new Set();
    return [...(left || []), ...(right || [])].filter(item => {
      const key = keyOf(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const addressPairKey = item => {
    const token = String(item?.token_contract_address || "").trim().toLowerCase();
    const spender = String(item?.spender_address || "").trim().toLowerCase();
    return token && spender ? token + ":" + spender : JSON.stringify(item ?? {});
  };

  const mergedNetworks = (next.networks || []).map(network => {
    const oldNetwork = (previous.networks || []).find(item => item.network === network.network);
    const addresses = (network.addresses || []).map(address => {
      const oldAddress = (oldNetwork?.addresses || []).find(
        item => String(item.address || "").toLowerCase() === String(address.address || "").toLowerCase()
      );
      return {
        ...address,
        // Transfer identity is a log, not a transaction: one transaction may
        // contain multiple ERC-20 Transfer events for the same verified wallet.
        token_transfers: mergeUnique(
          oldAddress?.token_transfers,
          address.token_transfers,
          item => tokenTransferIdentity(item)
        ),
        approvals: mergeUnique(
          oldAddress?.approvals,
          address.approvals,
          item => String(item.tx_hash || "").toLowerCase() + ":" + String(item.log_index || "").toLowerCase()
        ),
        // Page two can contain no new approvals. Keep earlier live allowance
        // reads, while preferring a fresher reading when the same pair recurs.
        current_allowance_checks: mergeUnique(
          address.current_allowance_checks,
          oldAddress?.current_allowance_checks,
          addressPairKey
        ),
        warnings: mergeUnique(oldAddress?.warnings, address.warnings, item => item),
      };
    });
    return { ...network, addresses };
  });

  return { ...next, networks: mergedNetworks };
}
