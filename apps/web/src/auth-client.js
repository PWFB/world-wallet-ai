import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";
import { isUsableNeonAccessToken } from "./neon-token.js";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

// Neon Auth is hosted on a different origin from the Render SPA. Include
// credentials for cookie-backed session restoration and JWT exchange.
export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter({
    fetchOptions: {
      credentials: "include",
    },
  }),
});

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
