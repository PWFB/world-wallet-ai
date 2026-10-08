import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

// React client: session state + OAuth/session lifecycle.
export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

// Vanilla client: exposes the Managed Neon Auth JWT token endpoint.
const tokenClient = createAuthClient(authUrl);

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  try {
    // Managed Neon Auth issues the short-lived bearer JWT from /token.
    // This is the token the World Wallet API verifies with the Neon JWKS.
    if (typeof tokenClient.token === "function") {
      const result = await tokenClient.token();
      if (typeof result === "string") return result;
      return result?.data?.token || result?.token || "";
    }
  } catch {
    // Fall through to the compatibility helper below.
  }

  try {
    if (typeof tokenClient.getJWTToken === "function") {
      const result = await tokenClient.getJWTToken();
      if (typeof result === "string") return result;
      return result?.token || result?.data?.token || "";
    }
  } catch {
    // No usable token yet; the caller will retry after session restoration.
  }

  return "";
}
