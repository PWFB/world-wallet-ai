# Deploy a World Wallet AI contract from Termux

This flow is intended for Android Termux. It compiles Solidity locally, resolves local imports such as OpenZeppelin ERC-20, verifies the target chain, estimates fees, asks for an explicit typed confirmation, waits for a confirmation, and writes a JSON deployment manifest.

## BALMZ on Ethereum Sepolia

The repository's `contracts/BalmzToken.sol` contract defines **BALMZ Token (BALMZ)** with 18 decimals and a fixed initial supply of 1,000,000,000 tokens, all assigned to the deploying wallet. The source code is not evidence of deployment; only a confirmed transaction and on-chain verification establish the deployed address and supply.

## 1. Install Termux tools

```sh
pkg update -y
pkg install -y nodejs-lts git
mkdir -p ~/world-wallet-contracts
cd ~/world-wallet-contracts
npm init -y
npm install ethers@^6 solc@^0.8 @openzeppelin/contracts
```

If you use the repository checkout, install the contract dependencies from its `contracts` folder with `npm install` there. The deploy helper resolves `solc` and `ethers` from its own location first, then falls back to the `contracts` project dependencies, so a duplicate root-level install is not required. It also looks for Solidity imports in the source directory and local `node_modules` folders.

## 2. Configure a Sepolia RPC endpoint

Create an Ethereum Sepolia app with a trusted provider such as Alchemy, then copy its HTTPS RPC URL. Do not paste the URL or API key into ChatGPT, commit it, or print it to terminal logs. If an RPC API key has been exposed, rotate it in the provider dashboard first.

In Termux, enter the endpoint without echoing it:

```sh
read -rsp "Sepolia RPC URL (hidden): " RPC_URL
echo
export RPC_URL
export NETWORK_NAME=sepolia
```

## 3. Prepare the wallet securely

Use a dedicated test wallet with **Sepolia test ETH only**. Never use a production wallet or put a private key in a source file, GitHub, a web form, or chat. Enter the private key hidden in the local shell:

```sh
read -rsp "Dedicated Sepolia test-wallet private key (hidden): " PRIVATE_KEY
echo
export PRIVATE_KEY
```

If you prefer, set `DEPLOYER_PRIVATE_KEY` in the environment instead. Never print it or paste it into a support conversation.

## 4. Run the guarded deploy helper

From the repository root:

```sh
node tools/termux-deploy.mjs contracts/BalmzToken.sol BalmzToken
```

Or, if you copied the Solidity source and helper into your own working folder, use their actual paths and exact contract name.

The helper:
- refuses any chain other than Sepolia (chain ID 11155111);
- compiles with the locally installed JavaScript Solidity compiler and resolves local imports;
- prints the derived deployer address, ETH balance, estimated gas, and estimated fee before sending anything;
- requires you to type exactly `DEPLOY BALMZ TO SEPOLIA` before broadcasting a BALMZ deployment;
- verifies the confirmed BALMZ name, symbol, decimals, total supply, and that the entire initial supply belongs to the deployer;
- writes `world-wallet-deployment.json` only after successful on-chain verification, and refuses to overwrite an existing manifest.

If you do not enter the exact confirmation phrase, the helper cancels without submitting a transaction. Keep enough Sepolia ETH for gas.

After running, remove the local secret variables:

```sh
unset PRIVATE_KEY DEPLOYER_PRIVATE_KEY RPC_URL SEPOLIA_RPC_URL
```

## 5. Verify and import

Open the printed Sepolia Etherscan address and transaction links and independently confirm the contract code and token metadata. Then import the generated manifest through **World Wallet AI → Contract Generator**. Importing a manifest saves a contract reference; it does not deploy, verify source code, or prove production reserves.

## Security

- Never commit RPC API keys, private keys, recovery phrases, `.env` files, or wallet backups.
- Testnet tokens have no implied market value and are not proof of production reserves.
- Review contract source independently before handling real assets.
