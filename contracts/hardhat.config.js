require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const ETH_RPC_URL = process.env.ETH_RPC_URL || "";

module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {},
    ethereum: {
      url: ETH_RPC_URL,
      chainId: 1,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
