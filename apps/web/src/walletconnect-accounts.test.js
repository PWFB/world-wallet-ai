import test from "node:test";
import assert from "node:assert/strict";
import {
  getWalletConnectSessionConnections,
  WALLETCONNECT_EVM_CHAIN_IDS,
} from "./walletconnect-accounts.js";

const ETH = "0x1111111111111111111111111111111111111111";
const BNB = "0x2222222222222222222222222222222222222222";
const SEPOLIA = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";

test("supports Ethereum, BNB and Sepolia EVM networks", () => {
  assert.deepEqual(WALLETCONNECT_EVM_CHAIN_IDS, [1, 56, 11155111]);
});

test("imports all approved accounts across multiple WalletConnect chains", () => {
  const session = {
    namespaces: {
      eip155: {
        accounts: [
          "eip155:1:" + ETH,
          "eip155:56:" + BNB,
          "eip155:11155111:" + SEPOLIA,
          "eip155:56:" + OTHER,
        ],
      },
    },
  };

  assert.deepEqual(
    getWalletConnectSessionConnections(session),
    [
      { chainId: 1, address: ETH },
      { chainId: 56, address: BNB },
      { chainId: 11155111, address: SEPOLIA },
      { chainId: 56, address: OTHER },
    ],
  );
});

test("merges active-chain account updates without dropping other approved chains", () => {
  const session = {
    namespaces: { eip155: { accounts: ["eip155:1:" + ETH, "eip155:56:" + BNB] } },
  };
  const changedAccount = "0x5555555555555555555555555555555555555555";

  assert.deepEqual(
    getWalletConnectSessionConnections(session, "0x38", [changedAccount, BNB]),
    [
      { chainId: 1, address: ETH },
      { chainId: 56, address: BNB },
      { chainId: 56, address: changedAccount },
    ],
  );
});

test("uses current-chain accounts when the provider has no session namespace", () => {
  assert.deepEqual(
    getWalletConnectSessionConnections(null, 1, [ETH, OTHER]),
    [
      { chainId: 1, address: ETH },
      { chainId: 1, address: OTHER },
    ],
  );
});

test("ignores unsupported namespaces, chains, malformed and non-EVM accounts", () => {
  const session = {
    namespaces: {
      eip155: {
        accounts: [
          "eip155:8453:" + OTHER,
          "eip155:97:" + BNB,
          "eip155:1:not-an-address",
          "eip155:56:" + "0x1234",
          "solana:mainnet:" + ETH,
          "eip155:1",
        ],
      },
    },
  };
  assert.deepEqual(getWalletConnectSessionConnections(session), []);
});

test("deduplicates duplicate addresses case-insensitively within each chain", () => {
  const session = {
    namespaces: {
      eip155: {
        accounts: [
          "eip155:1:" + ETH,
          "eip155:1:" + ETH.toUpperCase().replace("0X", "0x"),
          "eip155:56:" + ETH,
        ],
      },
    },
  };
  assert.deepEqual(
    getWalletConnectSessionConnections(session),
    [
      { chainId: 1, address: ETH },
      { chainId: 56, address: ETH },
    ],
  );
});
