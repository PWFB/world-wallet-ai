import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";
const TOKEN_EXPIRY_SKEW_SECONDS = 30;

// Neon Auth is hosted on a different origin from the Render SPA. Include
// credentials for cookie-backed session restoration and JWT exchange.
export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter({
    fetchOptions: {
      credentials: "include",
    },
  }),
});

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

// A compact JWT shape alone is not enough: forwarding an expired token causes
// the API to reject every request. Require a readable exp claim with a small
// clock-skew margin; signature and issuer validation remain the backend's job.
export function isUsableNeonAccessToken(value, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return false;
  const claims = decodeJwtPayload(value);
  return Number.isFinite(claims?.exp) && claims.exp > nowSeconds + TOKEN_EXPIRY_SKEW_SECONDS;
}

function tokenFromResult(result) {
  if (typeof result === "string") return result;
  return result?.token || result?.data?.token || "";
}

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  try {
    const token = tokenFromResult(await authClient.getJWTToken());
    if (isUsableNeonAccessToken(token)) return token;
  } catch {
    // Fall through to the session-cookie token endpoint during restoration.
  }

  try {
    const response = await fetch(authUrl.replace(/\/$/, "") + "/token", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok) {
      const data = await response.json();
      const token = tokenFromResult(data);
      if (isUsableNeonAccessToken(token)) return token;
    }
  } catch {
    // The caller can keep the UI stable and ask the user to sign in again.
  }

  return "";
}
