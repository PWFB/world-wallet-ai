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

function isJwt(value) {
  // A Neon API key or opaque session identifier is not a bearer JWT.
  // Only forward the compact three-part JWT format to the wallet API.
  return typeof value === "string" && value.split(".").length === 3 && value.split(".").every(Boolean);
}

function extractJwt(value) {
  if (isJwt(value)) return value;
  if (!value || typeof value !== "object") return "";
  // Neon Auth SDK response envelopes can differ between beta releases.
  // Accept only a compact JWT; never pass an opaque session ID/API key onward.
  for (const candidate of [
    value.token,
    value.data?.token,
    value.data?.data?.token,
    value.session?.token,
    value.data?.session?.token,
  ]) {
    if (isJwt(candidate)) return candidate;
  }
  return "";
}

export async function getNeonAccessToken() {
  if (!authUrl) return "";

  // Session restoration can finish just after the page mounts. Make a few
  // short attempts before declaring the wallet API unauthenticated.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = extractJwt(await authClient.getJWTToken());
      if (token) return token;
    } catch {
      // Fall through to the credentialed token endpoint.
    }

    try {
      const response = await fetch(authUrl.replace(/\/$/, "") + "/token", {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.ok) {
        const token = extractJwt(await response.json());
        if (token) return token;
      }
    } catch {
      // Retry while the browser restores the Neon Auth session cookie.
    }

    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }

  return "";
}
