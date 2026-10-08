import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  // Neon Auth's JWT plugin exposes GET /token. Fetch it directly with the
  // Better Auth session cookie so OAuth callbacks do not depend on the
  // React session cache already containing the JWT.
  try {
    const response = await fetch(`${authUrl.replace(/\/$/, "")}/token`, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.ok) {
      const data = await response.json();
      if (typeof data?.token === "string" && data.token) return data.token;
    }
  } catch {
    // Fall through to the SDK helper below.
  }

  try {
    // SDK fallback for environments where the direct token endpoint is not
    // available but the authenticated client session already has a JWT.
    if (typeof authClient.getJWTToken === "function") {
      const result = await authClient.getJWTToken();
      if (typeof result === "string") return result;
      return result?.token || result?.data?.token || "";
    }
  } catch {
    // The session may have just been created; the caller can retry.
  }

  return "";
}
