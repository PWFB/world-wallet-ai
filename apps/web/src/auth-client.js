import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  try {
    // Use the same Better Auth client that owns the browser session.
    // Neon exposes getJWTToken() for authenticated API bearer tokens.
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
