import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
});

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  if (typeof authClient.getJWTToken === "function") {
    const result = await authClient.getJWTToken();
    if (typeof result === "string") return result;
    return result?.token || result?.data?.token || "";
  }

  if (typeof authClient.token === "function") {
    const result = await authClient.token();
    return result?.data?.token || result?.token || "";
  }

  return "";
}
