import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  // Prefer the official Neon Auth SDK JWT exchange. Neon Auth keeps the
  // browser session in an http-only cookie and exchanges that session for a
  // short-lived JWT used as the API Bearer token.
  try {
    if (typeof authClient.getJWTToken === "function") {
      const result = await authClient.getJWTToken();
      const token = typeof result === "string"
        ? result
        : result?.token || result?.data?.token || "";
      if (typeof token === "string" && token) return token;
    }
  } catch {
    // Fall through to the direct endpoint for SDK versions where the helper
    // is temporarily unavailable during session restoration.
  }

  // Compatibility fallback for the hosted Neon Auth JWT endpoint.
  try {
    const response = await fetch(authUrl.replace(/\/$/, "") + "/token", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok) {
      const data = await response.json();
      if (typeof data?.token === "string" && data.token) return data.token;
    }
  } catch {
    // The caller will retry while the Neon session is being restored.
  }

  return "";
}
