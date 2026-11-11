import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Wallet } from "ethers";
import {
  ERC1271_MAGIC_VALUE,
  verifyEip1271Signature,
  verifyEvmMessageSignature,
  verifyEvmTypedDataSignature,
} from "./wallet-signatures.js";
import {
  OKX_EIP7702_CODE_PREFIX,
  OKX_WALLETCORE_IMPLEMENTATION,
  encodeOkxWalletCoreSelfExecution,
  isExpectedOkxWalletCoreDelegation,
} from "./okx-walletcore.js";

test("personal-message signature verifies against its recovered EOA", async () => {
  const wallet = Wallet.createRandom();
  const message = "World Wallet AI signature verification test";
  const signature = await wallet.signMessage(message);
  const result = verifyEvmMessageSignature(message, signature, wallet.address);
  assert.equal(result.valid, true);
  assert.equal(result.recoveredAddress, wallet.address);
  assert.equal(result.signatureType, "personal_sign");
});

test("personal-message signature rejects a different expected address", async () => {
  const wallet = Wallet.createRandom();
  const other = Wallet.createRandom();
  const signature = await wallet.signMessage("same message");
  assert.equal(verifyEvmMessageSignature("same message", signature, other.address).valid, false);
});

test("personal-message signature rejects altered content", async () => {
  const wallet = Wallet.createRandom();
  const signature = await wallet.signMessage("original");
  assert.equal(verifyEvmMessageSignature("altered", signature, wallet.address).valid, false);
});

test("EIP-712 typed-data signature verifies and detects wrong signer", async () => {
  const wallet = Wallet.createRandom();
  const other = Wallet.createRandom();
  const domain = { name: "World Wallet AI", version: "1", chainId: 1 };
  const types = {
    WalletVerification: [
      { name: "wallet", type: "address" },
      { name: "nonce", type: "string" },
    ],
  };
  const value = { wallet: wallet.address, nonce: "test-nonce-001" };
  const signature = await wallet.signTypedData(domain, types, value);
  assert.equal(verifyEvmTypedDataSignature(domain, types, value, signature, wallet.address).valid, true);
  assert.equal(verifyEvmTypedDataSignature(domain, types, value, signature, other.address).valid, false);
});

test("verification rejects malformed signature and address", () => {
  assert.throws(() => verifyEvmMessageSignature("message", "0x1234", "bad-address"), /valid expected EVM address/);
  assert.throws(() => verifyEvmMessageSignature("message", "0x1234", "0x1111111111111111111111111111111111111111"), /65-byte EVM signature/);
});

const ERC1271_ABI = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const WALLET = "0xbbdb482ae0895e496676ec84501d2945a404ff2c";
const DIGEST = "0x" + "11".repeat(32);
const SIGNATURE = "0x" + "22".repeat(65);

function makeMockProvider({
  chainId = 1n,
  code = "0xef0100" + "80".repeat(20),
  magic = ERC1271_MAGIC_VALUE,
  failCall = false,
} = {}) {
  return {
    async getNetwork() { return { chainId }; },
    async getCode() { return code; },
    async call() {
      if (failCall) throw new Error("call failed");
      return ERC1271_ABI.encodeFunctionResult("isValidSignature", [magic]);
    },
  };
}

test("ERC-1271 accepts the standard magic value from the selected smart wallet", async () => {
  const result = await verifyEip1271Signature(makeMockProvider(), WALLET, DIGEST, SIGNATURE, 1);
  assert.equal(result.valid, true);
  assert.equal(result.standard, "EIP-1271");
  assert.equal(result.walletAddress, "0xBbDb482aE0895e496676eC84501d2945a404FF2C");
  assert.equal(result.chainId, 1);
});

test("ERC-1271 rejects a non-magic return value", async () => {
  const result = await verifyEip1271Signature(
    makeMockProvider({ magic: "0xffffffff" }),
    WALLET,
    DIGEST,
    SIGNATURE,
    1,
  );
  assert.equal(result.valid, false);
});

test("ERC-1271 refuses the wrong RPC chain", async () => {
  await assert.rejects(
    verifyEip1271Signature(makeMockProvider({ chainId: 56n }), WALLET, DIGEST, SIGNATURE, 1),
    /chain ID does not match/,
  );
});

test("ERC-1271 refuses missing code and call failures", async () => {
  await assert.rejects(
    verifyEip1271Signature(makeMockProvider({ code: "0x" }), WALLET, DIGEST, SIGNATURE, 1),
    /No contract or EIP-7702 delegation code/,
  );
  await assert.rejects(
    verifyEip1271Signature(makeMockProvider({ failCall: true }), WALLET, DIGEST, SIGNATURE, 1),
    /did not accept the ERC-1271/,
  );
});


test("recognizes only the exact configured OKX WalletCore EIP-7702 delegation", () => {
  const code = OKX_EIP7702_CODE_PREFIX + OKX_WALLETCORE_IMPLEMENTATION.slice(2);
  assert.equal(isExpectedOkxWalletCoreDelegation(code), true);
  assert.equal(isExpectedOkxWalletCoreDelegation("0x"), false);
  assert.equal(isExpectedOkxWalletCoreDelegation("0xef0100" + "11".repeat(20)), false);
  assert.equal(isExpectedOkxWalletCoreDelegation(code.slice(0, -2)), false);
});

test("encodes WalletCore executeFromSelf with native and ERC-20 calls", () => {
  const calls = [
    { target: "0x1111111111111111111111111111111111111111", value: 123n, data: "0x" },
    { target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0xa9059cbb" + "0".repeat(128) },
  ];
  const encoded = encodeOkxWalletCoreSelfExecution(calls);
  const iface = new Interface(["function executeFromSelf((address target,uint256 value,bytes data)[] calls)"]);
  const decoded = iface.decodeFunctionData("executeFromSelf", encoded)[0];
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].target, calls[0].target);
  assert.equal(decoded[0].value, 123n);
  assert.equal(decoded[0].data, "0x");
  assert.equal(decoded[1].target, calls[1].target);
  assert.equal(decoded[1].value, 0n);
  assert.equal(decoded[1].data, calls[1].data);
});

test("rejects empty, invalid, or negative WalletCore execution calls", () => {
  assert.throws(() => encodeOkxWalletCoreSelfExecution([]), /At least one/);
  assert.throws(() => encodeOkxWalletCoreSelfExecution([{ target: "bad", value: 0, data: "0x" }]), /invalid target/);
  assert.throws(() => encodeOkxWalletCoreSelfExecution([{ target: "0x1111111111111111111111111111111111111111", value: -1, data: "0x" }]), /negative/);
  assert.throws(() => encodeOkxWalletCoreSelfExecution([{ target: "0x1111111111111111111111111111111111111111", value: 0, data: "zz" }]), /hexadecimal/);
});
