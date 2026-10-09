require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const ETH_RPC_URL = process.env.ETH_RPC_URL || "";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || process.env.WORLD_WALLET_SEPOLIA_RPC_URL || "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {},
    ethereum: {
      url: ETH_RPC_URL,
      chainId: 1,
      accounts,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts,
    },
  },
};
