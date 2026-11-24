import test from "node:test";
import assert from "node:assert/strict";
import { collectWalletConnectAccounts, mergeWalletConnectConnections, parseWalletConnectAccount } from "./walletconnect-evm.js";

test("parses supported EIP-155 Ethereum, BNB and Sepolia accounts", () => {
  assert.equal(parseWalletConnectAccount("eip155:1:0x1111111111111111111111111111111111111111").network, "ethereum");
  assert.equal(parseWalletConnectAccount("eip155:56:0x2222222222222222222222222222222222222222").network, "bnb");
  assert.equal(parseWalletConnectAccount("eip155:11155111:0x3333333333333333333333333333333333333333").network, "sepolia");
});

test("rejects malformed, unsupported and non-EVM accounts", () => {
  for (const value of ["solana:mainnet:abc","eip155:137:0x1111111111111111111111111111111111111111","eip155:1:not-an-address","eip155:0x1:0x1111111111111111111111111111111111111111"]) {
    assert.equal(parseWalletConnectAccount(value), null);
  }
});

test("collects every supported chain approved in the session and the active-chain account", () => {
  const session = { namespaces: { eip155: { accounts: [
    "eip155:1:0x1111111111111111111111111111111111111111",
    "eip155:56:0x2222222222222222222222222222222222222222",
    "eip155:11155111:0x3333333333333333333333333333333333333333",
    "eip155:137:0x4444444444444444444444444444444444444444",
  ] } } };
  const accounts = collectWalletConnectAccounts(session, "0x38", [
    "0x2222222222222222222222222222222222222222",
    "0x5555555555555555555555555555555555555555",
  ]);
  assert.equal(accounts.length, 4);
  assert.deepEqual(accounts.map(item => item.chainId), [1,56,11155111,56]);
  assert.equal(accounts.at(-1).address, "0x5555555555555555555555555555555555555555");
});

test("merges per wallet/provider/chain/address while retaining other saved records", () => {
  const old = [
    { walletId:"10000000008", providerId:"binance", chainId:56, address:"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { walletId:"10000000008", providerId:"walletconnect", chainId:1, address:"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  ];
  const incoming = [
    { walletId:"10000000008", providerId:"walletconnect", chainId:56, address:"0xcccccccccccccccccccccccccccccccccccccccc" },
    { walletId:"10000000008", providerId:"walletconnect", chainId:1, address:"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", label:"Updated" },
  ];
  const merged = mergeWalletConnectConnections(old, incoming);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].providerId, "binance");
  assert.equal(merged.find(item => item.chainId === 1 && item.providerId === "walletconnect").label, "Updated");
});
