import { createAuthClient } from "@neondatabase/auth";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

export const authClient = createAuthClient(authUrl);

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  // Managed Neon Auth exposes the authenticated JWT through token().
  // Keep a compatibility fallback for SDK builds that expose getJWTToken().
  if (typeof authClient.token === "function") {
    const result = await authClient.token();
    const token = result?.data?.token || result?.token || "";
    if (token) return token;
  }

  if (typeof authClient.getJWTToken === "function") {
    const result = await authClient.getJWTToken();
    if (!result) return "";
    if (typeof result === "string") return result;
    return result.token || result.data?.token || "";
  }

  return "";
}
