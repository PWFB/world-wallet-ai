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
  if (!authUrl) return "";

  // Use Neon Auth's documented /token endpoint first. In the pinned
  // @neondatabase/auth beta, SDK token helpers can surface a cached session
  // token instead of the short-lived API JWT expected by this backend.
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
    // The SDK compatibility paths below may still have a valid session token.
  }

  if (typeof authClient.token === "function") {
    try {
      const token = extractNeonToken(await authClient.token());
      if (isUsableNeonAccessToken(token)) return token;
    } catch {
      // Try getJWTToken() as the final SDK compatibility path.
    }
  }

  if (typeof authClient.getJWTToken === "function") {
    try {
      const token = extractNeonToken(await authClient.getJWTToken());
      if (isUsableNeonAccessToken(token)) return token;
    } catch {
      // The caller handles an unavailable or expired session.
    }
  }

  return "";
}

export async function getNeonAccessToken({ forceRefresh = false } = {}) {
  if (!authUrl) return "";
  // Always exchange the authenticated Neon cookie for the API JWT. forceRefresh
  // is retained for compatibility with existing callers and documentation.
  void forceRefresh;
  return requestTokenEndpoint();
}
