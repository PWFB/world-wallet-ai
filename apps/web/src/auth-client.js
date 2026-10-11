import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";
import { extractNeonToken, isUsableNeonAccessToken } from "./neon-token.js";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

export const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter({
    fetchOptions: {
      credentials: "include",
    },
  }),
});

async function requestTokenEndpoint() {
  // Neon Auth's Better Auth JWT plugin exposes /token and the SDK's
  // jwtClient plugin exposes the same endpoint as authClient.token().
  // Prefer the SDK method so its configured fetch/cookie behavior is retained.
  if (typeof authClient.token === "function") {
    try {
      const result = await authClient.token();
      const token = extractNeonToken(result);
      if (isUsableNeonAccessToken(token)) return token;
    } catch {
      // Try the documented endpoint directly as a compatibility fallback.
    }
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
      const token = extractNeonToken(data);
      if (isUsableNeonAccessToken(token)) return token;
    }
  } catch {
    // The caller can keep the UI stable and ask the user to sign in again.
  }

  return "";
}

export async function getNeonAccessToken({ forceRefresh = false } = {}) {
  if (!authUrl) return "";

  // A forced refresh must hit the JWT endpoint; getJWTToken() can return the
  // token held in the SDK's current session state rather than force a new JWT.
  if (forceRefresh) return requestTokenEndpoint();

  try {
    const token = extractNeonToken(await authClient.getJWTToken());
    if (isUsableNeonAccessToken(token)) return token;
  } catch {
    // Fall through to the JWT endpoint during session restoration.
  }

  return requestTokenEndpoint();
}
