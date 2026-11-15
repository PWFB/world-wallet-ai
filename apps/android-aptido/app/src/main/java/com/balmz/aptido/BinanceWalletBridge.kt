package com.balmz.aptido

import android.net.Uri
import java.security.SecureRandom

internal data class BinanceWalletCallback(
    val mode: String,
    val nonce: String,
    val provider: String,
    val namespace: String,
    val chainId: String,
    val address: String,
    val challengeId: String,
    val signature: String
)

internal object BinanceWalletBridge {
    const val CALLBACK_SCHEME = "balmzaptido"
    const val CALLBACK_HOST = "wallet-connect"
    const val BRIDGE_URL = "https://world-wallet-ai-backend.onrender.com/api/v1/public/aptido-wallet-bridge"
    private val secureRandom = SecureRandom()

    fun newNonce(): String {
        val bytes = ByteArray(32)
        secureRandom.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun connectUrl(nonce: String): String {
        require(isNonce(nonce)) { "Invalid connection request code." }
        return Uri.parse(BRIDGE_URL).buildUpon()
            .appendQueryParameter("mode", "connect")
            .appendQueryParameter("nonce", nonce)
            .build().toString()
    }

    fun verifyUrl(
        nonce: String,
        chainId: String,
        address: String,
        challengeId: String,
        message: String
    ): String {
        require(isNonce(nonce)) { "Invalid proof request code." }
        require(normalizeChainId(chainId) in setOf("0x1", "0x38")) { "Unsupported EVM mainnet." }
        require(isEvmAddress(address)) { "Invalid EVM address." }
        require(Regex("^wac_[A-Za-z0-9_-]{16,100}$").matches(challengeId)) { "Invalid ownership challenge." }
        require(message.isNotBlank() && message.length <= 1200) { "Invalid ownership challenge message." }
        return Uri.parse(BRIDGE_URL).buildUpon()
            .appendQueryParameter("mode", "verify")
            .appendQueryParameter("nonce", nonce)
            .appendQueryParameter("chain_id", normalizeChainId(chainId))
            .appendQueryParameter("address", address)
            .appendQueryParameter("challenge_id", challengeId)
            .appendQueryParameter("message", message)
            .build().toString()
    }

    fun parseCallback(uri: Uri): BinanceWalletCallback {
        require(uri.scheme == CALLBACK_SCHEME && uri.host == CALLBACK_HOST && uri.path == "/callback") {
            "Untrusted wallet return link."
        }
        val mode = uri.getQueryParameter("mode").orEmpty()
        val nonce = uri.getQueryParameter("nonce").orEmpty()
        val provider = uri.getQueryParameter("provider").orEmpty()
        val namespace = uri.getQueryParameter("namespace").orEmpty()
        val chainId = normalizeChainId(uri.getQueryParameter("chain_id").orEmpty())
        val address = uri.getQueryParameter("address").orEmpty()
        val challengeId = uri.getQueryParameter("challenge_id").orEmpty()
        val signature = uri.getQueryParameter("signature").orEmpty()

        require(mode in setOf("connected", "verified")) { "Unsupported wallet callback mode." }
        require(isNonce(nonce)) { "Invalid wallet callback request code." }
        require(provider == "binance" && namespace == "eip155") { "Unsupported external wallet provider or network namespace." }
        require(chainId in setOf("0x1", "0x38")) { "Only Ethereum and BNB mainnet are supported by this connection flow." }
        require(isEvmAddress(address)) { "The external wallet returned an invalid EVM address." }
        if (mode == "verified") {
            require(Regex("^wac_[A-Za-z0-9_-]{16,100}$").matches(challengeId)) { "Missing ownership challenge identifier." }
            require(Regex("^0x[0-9a-fA-F]{130}$").matches(signature)) { "The wallet returned an invalid personal-message signature." }
        }
        return BinanceWalletCallback(mode, nonce, provider, namespace, chainId, address, challengeId, signature)
    }

    fun normalizeChainId(value: String): String = value.trim().lowercase()

    fun networkFor(chainId: String): String = when (normalizeChainId(chainId)) {
        "0x1" -> "ethereum"
        "0x38" -> "bnb"
        else -> throw IllegalArgumentException("Only Ethereum and BNB mainnet are supported.")
    }

    fun isNonce(value: String): Boolean = Regex("^[0-9a-fA-F]{64}$").matches(value)

    fun isEvmAddress(value: String): Boolean = Regex("^0x[0-9a-fA-F]{40}$").matches(value)
}

internal data class PendingExternalWalletProof(
    val walletId: String,
    val network: String,
    val chainId: String,
    val address: String,
    val challengeId: String,
    val message: String
) {
    fun toJson(): org.json.JSONObject = org.json.JSONObject()
        .put("wallet_id", walletId)
        .put("network", network)
        .put("chain_id", chainId)
        .put("address", address)
        .put("challenge_id", challengeId)
        .put("message", message)

    companion object {
        fun fromJson(value: org.json.JSONObject): PendingExternalWalletProof? {
            val walletId = value.optString("wallet_id")
            val network = value.optString("network")
            val chainId = BinanceWalletBridge.normalizeChainId(value.optString("chain_id"))
            val address = value.optString("address")
            val challengeId = value.optString("challenge_id")
            val message = value.optString("message")
            if (walletId.isBlank() || network !in setOf("ethereum", "bnb") ||
                chainId !in setOf("0x1", "0x38") || !BinanceWalletBridge.isEvmAddress(address) ||
                !Regex("^wac_[A-Za-z0-9_-]{16,100}$").matches(challengeId) || message.isBlank()
            ) return null
            if (BinanceWalletBridge.networkFor(chainId) != network) return null
            return PendingExternalWalletProof(walletId, network, chainId, address, challengeId, message)
        }
    }
}

internal data class ExternalWalletAccount(
    val provider: String,
    val namespace: String,
    val chainId: String,
    val network: String,
    val address: String,
    val connectedAt: Long,
    val ownershipVerified: Boolean
) {
    fun toJson(): org.json.JSONObject = org.json.JSONObject()
        .put("provider", provider)
        .put("namespace", namespace)
        .put("chain_id", chainId)
        .put("network", network)
        .put("address", address)
        .put("connected_at", connectedAt)
        .put("ownership_verified", ownershipVerified)

    companion object {
        fun fromJson(value: org.json.JSONObject): ExternalWalletAccount? {
            val provider = value.optString("provider")
            val namespace = value.optString("namespace")
            val chainId = BinanceWalletBridge.normalizeChainId(value.optString("chain_id"))
            val network = value.optString("network")
            val address = value.optString("address")
            val connectedAt = value.optLong("connected_at", 0L)
            if (provider != "binance" || namespace != "eip155" || chainId !in setOf("0x1", "0x38") ||
                network !in setOf("ethereum", "bnb") || BinanceWalletBridge.networkFor(chainId) != network ||
                !BinanceWalletBridge.isEvmAddress(address) || connectedAt <= 0L
            ) return null
            return ExternalWalletAccount(
                provider, namespace, chainId, network, address, connectedAt,
                value.optBoolean("ownership_verified", false)
            )
        }
    }
}
