import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

// The Neon Auth service is hosted on a different origin from the Render SPA.
// Explicitly include credentials so the browser can send/receive the Neon Auth
// session cookie during sign-in, OTP, session restoration, and JWT exchange.
export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter({
    fetchOptions: {
      credentials: "include",
    },
  }),
});

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  try {
    const result = await authClient.getJWTToken();
    const token = typeof result === "string"
      ? result
      : result?.token || result?.data?.token || "";
    if (typeof token === "string" && token) return token;
  } catch {
    // Fall through to the direct endpoint while the session is being restored.
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
      if (typeof data?.token === "string" && data.token) return data.token;
    }
  } catch {
    // The caller retries while Neon Auth finishes restoring the session.
  }

  return "";
}
