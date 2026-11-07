import test from "node:test";
import assert from "node:assert/strict";
import { NAVIGATION_ICONS, WALLET_NAVIGATION } from "./navigation.js";

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
