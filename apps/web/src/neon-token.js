const TOKEN_EXPIRY_SKEW_SECONDS = 30;

export function extractNeonToken(result) {
  if (typeof result === "string") return result;
  for (const candidate of [
    result.token,
    result.data?.token,
    result.data?.data?.token,
    result.session?.token,
    result.data?.session?.token,
  ]) {
    if (typeof candidate === "string") return candidate;
  }

  return "";
}

function decodeJwtPayload(token) {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    // Decode the JWT payload as UTF-8. Plain atob() produces a Latin-1
    // string and can reject otherwise valid claims containing Unicode names.
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function getNeonTokenExpiry(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return null;
  const claims = decodeJwtPayload(value);
  return Number.isFinite(claims?.exp) ? claims.exp : null;
}

// This is a client-side freshness check, not signature verification. The API
// must still verify the signature and enforce its issuer/expiry policy.
export function isUsableNeonAccessToken(value, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return false;
  const expiry = getNeonTokenExpiry(value);
  return expiry !== null && expiry > nowSeconds + TOKEN_EXPIRY_SKEW_SECONDS;
}
