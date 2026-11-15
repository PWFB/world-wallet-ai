package com.balmz.aptido

import wallet.core.jni.CoinType
import wallet.core.jni.HDWallet
import wallet.core.jni.Mnemonic

internal data class SelfCustodyAddress(
    val network: String,
    val address: String
)

internal data class GeneratedSelfCustodyWallet(
    val mnemonic: String,
    val addresses: List<SelfCustodyAddress>
)

/**
 * BIP-39 phrase and private-key derivation stay on-device.
 * Ethereum and BNB mainnets intentionally share one EVM address.
 * Sepolia and Solana Devnet use a distinct BIP-44 account index.
 *
 * Address derivation alone does not complete ownership verification,
 * WalletConnect, transaction preview, signing or broadcast.
 */
internal object TrustWalletCoreWallet {
    init {
        System.loadLibrary("TrustWalletCore")
    }

    fun create(): GeneratedSelfCustodyWallet = derive(HDWallet(128, ""))

    fun restore(recoveryPhrase: String): GeneratedSelfCustodyWallet {
        val normalized = recoveryPhrase.trim().lowercase().replace(Regex("\\s+"), " ")
        require(normalized.split(" ").size == 12 || normalized.split(" ").size == 24) {
            "Enter a valid 12- or 24-word recovery phrase."
        }
        require(Mnemonic.isValid(normalized)) {
            "That recovery phrase is not a valid BIP-39 mnemonic."
        }
        return derive(HDWallet(normalized, ""))
    }

    private fun derive(wallet: HDWallet): GeneratedSelfCustodyWallet {
        val phrase = wallet.mnemonic()
        require(Mnemonic.isValid(phrase)) { "Trust Wallet Core returned an invalid recovery phrase." }

        // One mainnet EVM address for both Ethereum and BNB Chain.
        val ethereumMainnet = wallet.getAddressForCoin(CoinType.ETHEREUM)
        require(ethereumMainnet.isNotBlank()) { "Ethereum address derivation failed." }

        // Trust Wallet Core's default Bitcoin path is native SegWit (BIP-84).
        val bitcoinMainnet = wallet.getAddressForCoin(CoinType.BITCOIN)
        require(bitcoinMainnet.isNotBlank()) { "Bitcoin address derivation failed." }

        val solanaMainnet = wallet.getAddressForCoin(CoinType.SOLANA)
        require(solanaMainnet.isNotBlank()) { "Solana mainnet address derivation failed." }

        // Account index 1 is distinct from the EVM mainnet account index 0.
        val sepoliaKey = requireNotNull(wallet.getKey(CoinType.ETHEREUM, "m/44'/60'/1'/0/0")) {
            "Ethereum Sepolia key derivation failed."
        }
        val sepoliaAddress = CoinType.ETHEREUM.deriveAddress(sepoliaKey)
        require(sepoliaAddress.isNotBlank() && !sepoliaAddress.equals(ethereumMainnet, ignoreCase = true)) {
            "A distinct Ethereum Sepolia address could not be derived."
        }

        // Account index 1 gives Solana Devnet its own key/address set.
        val solanaDevnetKey = requireNotNull(wallet.getKey(CoinType.SOLANA, "m/44'/501'/1'/0'")) {
            "Solana Devnet key derivation failed."
        }
        val solanaDevnetAddress = CoinType.SOLANA.deriveAddress(solanaDevnetKey)
        require(solanaDevnetAddress.isNotBlank() && solanaDevnetAddress != solanaMainnet) {
            "A distinct Solana Devnet address could not be derived."
        }

        val result = listOf(
            SelfCustodyAddress("ethereum", ethereumMainnet),
            SelfCustodyAddress("bnb", ethereumMainnet),
            SelfCustodyAddress("bitcoin", bitcoinMainnet),
            SelfCustodyAddress("solana_mainnet", solanaMainnet),
            SelfCustodyAddress("sepolia", sepoliaAddress),
            SelfCustodyAddress("solana_devnet", solanaDevnetAddress)
        )
        require(result.size == 6 && result.map { it.network }.toSet().size == 6) {
            "Trust Wallet Core did not return the complete supported network address set."
        }
        return GeneratedSelfCustodyWallet(phrase, result)
    }
}
