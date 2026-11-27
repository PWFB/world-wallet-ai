import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const featureSource = readFileSync(new URL("./FeaturePage.jsx", import.meta.url), "utf8");
const balmzAiSource = readFileSync(new URL("./BalmzAI.jsx", import.meta.url), "utf8");
const returnCenterSource = readFileSync(new URL("./MainnetReturnCenter.jsx", import.meta.url), "utf8");
const aptSource = readFileSync(new URL("../../../apps/android-aptido/app/src/main/java/com/balmz/aptido/MainActivity.kt", import.meta.url), "utf8");
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

test("every sidebar destination has an explicit screen handler from first to last", () => {
  const pages = Object.values(WALLET_NAVIGATION).flat();
  const applicationSource = appSource + "\n" + featureSource;
  const missing = pages.filter(page => {
    const markers = [
      'active === "' + page + '"',
      'active==="' + page + '"',
      "active === '" + page + "'",
      "active==='" + page + "'",
    ];
    return !markers.some(marker => applicationSource.includes(marker));
  });
  assert.deepEqual(missing, [], "Sidebar pages without a direct render route");
  assert.equal(pages.at(-1), "Help & Docs", "The audit must include the final sidebar destination");
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
  assert.equal(ROOT_SHORTCUTS.length, 7, "Root hub should remain compact while highlighting mining");
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


test("Etherscan API Test is directly discoverable in Admin and uses the owner-only read-only backend probe", () => {
  assert.ok(WALLET_NAVIGATION.ADMIN.includes("Etherscan API Test"));
  assert.ok(NAVIGATION_ICONS["Etherscan API Test"]);
  assert.match(featureSource, /active === "Etherscan API Test"/);
  assert.match(featureSource, /Test Etherscan API/);
  assert.match(featureSource, /api\/v1\/admin\/etherscan-provider\/test/);
  assert.match(featureSource, /fixed public probe address/);
});


test("admin System Settings labels all four Etherscan V2 networks correctly", () => {
  assert.match(featureSource, /Read-only API key checks for Ethereum, BNB Chain, Sepolia, and Polygon PoS/);
  assert.ok(featureSource.includes('item.network==="ethereum"?"Ethereum Mainnet":item.network==="bnb"?"BNB Chain Mainnet":item.network==="sepolia"?"Ethereum Sepolia":item.network==="polygon"?"Polygon PoS Mainnet":"Unknown network"'));
});

test("admin System Settings exposes Alchemy runtime verification without client-side secrets", () => {
  assert.match(featureSource, /Alchemy NFT API connectivity/);
  assert.match(featureSource, /Test Alchemy API/);
  assert.match(featureSource, /api\/v1\/admin\/nft-provider\/test/);
  assert.match(featureSource, /secret values are never returned/);
});


test("dashboard omits duplicate environment and chain catalogue cards while keeping wallet balance", () => {
  assert.doesNotMatch(appSource, /ACTIVE ENVIRONMENT/);
  assert.doesNotMatch(appSource, /web3-wallet-context/);
  assert.doesNotMatch(appSource, /dashboard-chain-grid/);
  assert.match(appSource, /web3-balance-grid/);
});

test("BALMZ presale offers wallet-linked early-access registration without enabling payments", () => {
  assert.match(featureSource, /BALMZ Presale early access/);
  assert.match(featureSource, /Register for presale updates/);
  assert.match(featureSource, /payment acceptance remains disabled/i);
  assert.match(featureSource, /Presale not open/);
});

test("WizzU Helper is discoverable and opens the guided wallet verification workflow", () => {
  assert.ok(WALLET_NAVIGATION.EXPLORE.includes("WizzU Helper"));
  assert.ok(NAVIGATION_ICONS["WizzU Helper"]);
  assert.match(featureSource, /active === "WizzU Helper"/);
  assert.match(featureSource, /WalletWizard/);
  assert.match(balmzAiSource, /WizzU Helper/);
});

test("BALMZ Token Mining is discoverable and has a genuine early-access registration workflow", () => {
  assert.ok(WALLET_NAVIGATION.EXPLORE.includes("Token Mining"));
  assert.ok(ROOT_SHORTCUTS.includes("Token Mining"));
  assert.ok(NAVIGATION_ICONS["Token Mining"]);
  assert.match(featureSource, /BALMZ Token Mining/);
  assert.match(featureSource, /Register my interest/);
  assert.match(featureSource, /BALMZ Token Mining early access/);
  assert.match(featureSource, /No background mining runs on your phone or computer/);
  assert.match(featureSource, /No claimable BALMZ rewards are being represented/);
});

test("Wallets page exposes a provider-specific OKX EVM connection flow", () => {
  assert.match(featureSource, /Connect OKX Wallet/);
  assert.match(featureSource, /window\.okxwallet/);
  assert.match(featureSource, /eth_requestAccounts/);
  assert.match(featureSource, /world_wallet_external_connections_v2/);
  assert.match(featureSource, /ownership is not yet verified/i);
  assert.match(featureSource, /Verify ownership/);
  assert.match(featureSource, /No transaction was sent/);
});

test("WalletConnect requires Ethereum Mainnet, BNB Mainnet and Sepolia for address ownership signing", () => {
  assert.ok((featureSource.match(/chains: \[1, 56, 11155111\]/g) || []).length >= 2,
    "both WalletConnect initialization paths must require all supported EVM chains");
  assert.doesNotMatch(featureSource, /optionalChains: \[11155111\]/,
    "Sepolia must not be optional while the session is expected to support all three networks");
  assert.match(featureSource, /sessionSupportsAllNetworks/);
  assert.match(featureSource, /missingChains/);
  assert.match(featureSource, /personal_sign/);
  assert.match(featureSource, /OKX connected without approving all required networks/);
});

test("OKX connection records remain separate from Binance records for the same chain and address", () => {
  const start = featureSource.indexOf("const connectOkxWallet");
  const end = featureSource.indexOf("const connectBinanceWallet", start);
  const okxFlow = featureSource.slice(start, end);
  assert.match(okxFlow, /providerId \|\| item\.provider[\s\S]*?=== "okx"/);
  assert.match(okxFlow, /provider: "okx"/);
  assert.match(okxFlow, /window\.okxwallet/);
});

test("WalletConnect QR connection is available from the Wallets page without a duplicate sidebar page", () => {
  const pages = Object.values(WALLET_NAVIGATION).flat();
  assert.ok(!pages.includes("Wallet Connect"));
  assert.match(featureSource, /Connect WalletConnect \(QR\)/);
  assert.match(featureSource, /EthereumProvider\.init/);
  assert.match(featureSource, /VITE_WALLETCONNECT_PROJECT_ID/);
  assert.match(featureSource, /collectWalletConnectAccounts/);
  assert.match(featureSource, /mergeWalletConnectConnections/);
  assert.match(featureSource, /world_wallet_external_connections_v2/);
  assert.match(featureSource, /ownership remains unverified/i);
  assert.match(featureSource, /No transaction was sent/);
  assert.doesNotMatch(appSource, /WalletConnect|walletconnect/i);
  assert.doesNotMatch(returnCenterSource, /WalletConnect|walletconnect|onConnectWalletConnect/i);
});
test("private Bank & Crypto services are tucked behind a collapsed APT section", () => {
  assert.ok(!Object.values(WALLET_NAVIGATION).flat().includes("US Bank Transfers"));
  assert.match(aptSource, /listOf\("Home", "Wallets", "More", "AI Chat"/);
  assert.match(aptSource, /var showPrivateServices by remember/);
  assert.match(aptSource, /Open private services/);
  assert.match(aptSource, /onRefreshPrivateServicesStatus/);
  assert.match(aptSource, /onBuyCrypto/);
  assert.match(aptSource, /usBankTransferStatus/);
  assert.doesNotMatch(aptSource, /Plaid|PlaidLink|OpenPlaidLink/);
});

test("crypto purchases require Coinbase readiness and ownership-verified mainnet destinations", () => {
  assert.match(aptSource, /enabled = !busy && coinbaseOnrampEnabled/);
  assert.match(aptSource, /ownershipVerified && address.network in setOf\("bitcoin", "ethereum", "solana_mainnet"\)/);
  assert.match(aptSource, /\/api\/v1\/bankconnect\/crypto\/buy-session/);
  assert.match(aptSource, /\/api\/v1\/bankconnect\/crypto\/status/);
});

test("web and APT dashboard cards have working navigation or action handlers", () => {
  assert.match(appSource, /function dashboardCardAction\(onActivate\)/);
  assert.ok((appSource.match(/dashboard-action-card/g) || []).length >= 10);
  assert.match(appSource, /setSelectedCoin\(symbol\)/);
  assert.match(appSource, /setFocusedTransaction\(a\)/);
  assert.match(appSource, /setActive\("Proof of Reserves"\)/);
  assert.match(aptSource, /onNavigate = \{ destination -> tab = destination \}/);
  assert.match(aptSource, /Modifier\.clickable\(onClick = onClick\)/);
});

test("Bitcoin external wallet connection is removed without removing built-in Bitcoin wallet support", () => {
  assert.doesNotMatch(returnCenterSource, /connectBitcoin|normalizeOkxBitcoinAccount/);
  assert.doesNotMatch(returnCenterSource, /key: "bitcoin"/);
  assert.match(aptSource, /"Bitcoin Mainnet" to "bitcoin"/);
});


test("Binance Web3 Wallet can be selected as a mainnet deposit recipient", () => {
  assert.match(featureSource, /Deposit to your Binance Web3 Wallet/);
  assert.match(featureSource, /Binance Web3 Wallet destination filled/);
  assert.match(featureSource, /Use Binance Wallet/);
  assert.match(featureSource, /\["ethereum", "bnb"\]/);
  assert.match(featureSource, /window\.binancew3w\?\.ethereum/);
  assert.match(featureSource, /does not initiate a transfer/);
  assert.match(featureSource, /eth_sendTransaction/);
  assert.match(featureSource, /ownership_verified !== true/);
});


test("normal Connect Wallet remains a separate injected-provider discovery flow", () => {
  assert.match(featureSource, /Connect Wallet/);
  assert.match(featureSource, /discoverEip6963Providers/);
  assert.match(featureSource, /eip6963-wallets/);
  assert.match(featureSource, /connectDiscoveredWallet/);
  assert.match(featureSource, /withProviderTimeout/);
  assert.match(featureSource, /Connect Wallet/);
  assert.match(featureSource, /discoverEip6963Providers/);
  assert.match(featureSource, /world_wallet_external_connections_v2/);
});

test("injected wallet discovery utilities map supported chains and impose request timeouts", () => {
  const source = readFileSync(new URL("./eip6963-wallets.js", import.meta.url), "utf8");
  assert.match(source, /eip6963:announceProvider/);
  assert.match(source, /eip6963:requestProvider/);
  assert.match(source, /windowRef\.ethereum/);
  assert.match(source, /windowRef\.binancew3w/);
  assert.match(source, /windowRef\.okxwallet/);
  assert.match(source, /60000/); // connection handler's account-request timeout
});

test("wallet balance UI never converts missing provider data into a zero balance", () => {
  assert.match(featureSource, /rawBalance = data\?\.balance/);
  assert.match(featureSource, /Number\.isFinite\(parsedBalance\)/);
  assert.match(featureSource, /no zero balance was assumed/);
});


test("transaction explorer links require a hash valid for the recorded network", () => {
  const source = readFileSync(new URL("./ActivityTrace.jsx", import.meta.url), "utf8");
  assert.match(source, /const evmHash = \/\^0x\[a-f0-9\]\{64\}\$\/i/);
  assert.match(source, /const bitcoinHash = \/\^\[a-f0-9\]\{64\}\$\/i/);
  assert.match(source, /const solanaSignature = \/\^\[1-9A-HJ-NP-Za-km-z\]\{64,88\}\$\//);
  assert.match(source, /return evmHash \? "https:\/\/etherscan\.io\/tx\//);
  assert.match(source, /return solanaSignature \? "https:\/\/solscan\.io\/tx\//);
});


test("portfolio balances are scoped to a network and never coerce missing values to zero", () => {
  assert.match(featureSource, /syncedBalanceNetworks = \[\]/);
  assert.match(featureSource, /portfolioNetworkKey = item =>/);
  assert.match(featureSource, /hasNumericBalance = value => typeof value !== "boolean" && value !== null && value !== undefined && value !== ""/);
  assert.match(featureSource, /USD value unavailable/);
  assert.match(appSource, /setSyncedBalanceNetworks/);
  assert.match(appSource, /network \+ ":" \+ symbol/);
  assert.match(appSource, /balanceSyncContextRef\.current !== nextContext/);
  assert.match(appSource, /setHasVerifiedMainnetBalance\(false\)/);
});


test("transaction detail explorer links require a network-specific valid transaction hash", () => {
  assert.match(featureSource, /const evmHash = \/\^0x\[a-f0-9\]\{64\}\$\/i/);
  assert.match(featureSource, /const hexHash = \/\^\[a-f0-9\]\{64\}\$\/i/);
  assert.match(featureSource, /const solanaSignature = \/\^\[1-9A-HJ-NP-Za-km-z\]\{64,88\}\$\//);
  assert.match(featureSource, /if \(network === "ethereum" \|\| network === "bnb" \|\| network === "sepolia" \|\| network === "polygon"\)/);
  assert.match(featureSource, /if \(network === "solana_mainnet" \|\| network === "solana_devnet"\)/);
  assert.match(featureSource, /if \(network === "bitcoin" \|\| network === "litecoin" \|\| network === "dogecoin"\)/);
  assert.match(featureSource, /return "";/);
});
