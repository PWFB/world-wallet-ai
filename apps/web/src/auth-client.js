import { createAuthClient } from "@neondatabase/auth";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

export const authClient = createAuthClient(authUrl);

export async function getNeonAccessToken() {
  if (!authUrl) return "";
  const result = await authClient.getJWTToken?.();
  if (!result) return "";
  if (typeof result === "string") return result;
  return result.token || result.data?.token || "";
}
