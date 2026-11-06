export function generateWalletNumber(existingEntries = [], cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.getRandomValues) {
    throw new Error("Secure random number generation is unavailable in this browser.");
  }
  const used = new Set((Array.isArray(existingEntries) ? existingEntries : []).map(item => String(item?.walletId || "")));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const random = new Uint32Array(2);
    cryptoProvider.getRandomValues(random);
    const value = (BigInt(random[0]) << 32n) | BigInt(random[1]);
    const walletNumber = String(10_000_000_000n + (value % 90_000_000_000n));
    if (!used.has(walletNumber)) return walletNumber;
  }
  throw new Error("Could not allocate a unique 11-digit wallet number. Please retry.");
}
