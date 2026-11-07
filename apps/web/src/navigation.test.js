import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const featureSource = readFileSync(new URL("./FeaturePage.jsx", import.meta.url), "utf8");
import { NAVIGATION_ICONS, ROOT_SHORTCUTS, WALLET_NAVIGATION } from "./navigation.js";

test("sidebar navigation starts with the wallet dashboard", () => {
  const groups = Object.entries(WALLET_NAVIGATION);
  assert.equal(groups[0][0], "MY WALLET");
  assert.equal(groups[0][1][0], "Dashboard");
});

test("the main wallet actions are reachable from the sidebar", () => {
  const pages = Object.values(WALLET_NAVIGATION).flat();
  for (const page of ["Wallets", "Portfolio", "Send", "Receive", "Deposit", "Withdraw", "Swap", "Transactions"]) {
    assert.ok(pages.includes(page), page + " must be reachable");
  }
});

test("the sidebar ends its support group with Help and Docs", () => {
  const groups = Object.keys(WALLET_NAVIGATION);
  assert.equal(groups.at(-1), "HELP & DOCS");
  assert.deepEqual(WALLET_NAVIGATION["HELP & DOCS"], ["Support Center", "Request Center", "Help & Docs"]);
});

test("every sidebar page has a meaningful icon and appears only once", () => {
  const pages = Object.values(WALLET_NAVIGATION).flat();
  assert.equal(new Set(pages).size, pages.length, "navigation labels must be unique");
  for (const page of pages) {
    assert.ok(typeof NAVIGATION_ICONS[page] === "string" && NAVIGATION_ICONS[page].length > 0, "missing icon for " + page);
  }
});

test("Root hub shortcuts resolve to real sidebar pages", () => {
  const pages = new Set(Object.values(WALLET_NAVIGATION).flat());
  assert.equal(ROOT_SHORTCUTS.length, 6, "Root hub should stay compact");
  for (const page of ROOT_SHORTCUTS) assert.ok(pages.has(page), "Root shortcut must resolve: " + page);
});


test("dashboard More opens the Root shortcut hub instead of duplicating the sidebar catalogue", () => {
  assert.doesNotMatch(appSource, /dashboard-more-grid|dashboard-more-sheet/);
  assert.match(appSource, /aria-label="Open all wallet pages and tools"/);
  assert.match(appSource, /setRootSearch\(""\);\s*setMobileMenuOpen\(true\)/);
  assert.match(appSource, /mobile-root-menu/);
});

test("the formerly incomplete profile, support, NFT, and staking destinations have dedicated screens", () => {
  for (const page of ["Profile", "Support Center", "NFTs", "Staking"]) {
    assert.ok(featureSource.includes('active === "' + page + '"'), "missing dedicated page: " + page);
  }
  assert.match(featureSource, /Submit support request/);
  assert.match(featureSource, /api\/v1\/wallet\/nfts/);
});

test("admin destinations use server-backed restricted endpoints", () => {
  for (const endpoint of [
    "/api/v1/admin/announcement",
    "/api/v1/admin/users",
    "/api/v1/admin/settings",
    "/api/v1/admin/activity",
    "/api/v1/admin/roles",
  ]) assert.ok(featureSource.includes(endpoint), "missing admin endpoint: " + endpoint);
});


test("admin System Settings exposes Alchemy runtime verification without client-side secrets", () => {
  assert.match(featureSource, /Alchemy NFT API connectivity/);
  assert.match(featureSource, /Test Alchemy API/);
  assert.match(featureSource, /api\/v1\/admin\/nft-provider\/test/);
  assert.match(featureSource, /secret values are never returned/);
});
