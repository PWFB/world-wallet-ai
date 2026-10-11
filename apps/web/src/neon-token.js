const TOKEN_EXPIRY_SKEW_SECONDS = 30;

function decodeJwtPayload(token) {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// This is a client-side freshness check, not signature verification. The API
// must still verify the signature and enforce its issuer/expiry policy.
export function isUsableNeonAccessToken(value, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return false;
  const claims = decodeJwtPayload(value);
  return Number.isFinite(claims?.exp) && claims.exp > nowSeconds + TOKEN_EXPIRY_SKEW_SECONDS;
}
