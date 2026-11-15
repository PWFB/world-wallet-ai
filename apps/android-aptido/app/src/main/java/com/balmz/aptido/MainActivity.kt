package com.balmz.aptido

import android.os.Bundle
import android.content.Intent
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Ink = Color(0xFF07111F)
private val Panel = Color(0xFF101D2D)
private val PanelLight = Color(0xFF17263A)
private val Orange = Color(0xFFFF7A18)
private val Paper = Color(0xFFF4F7FB)
private val Muted = Color(0xFF9AA9BC)
private val Green = Color(0xFF68D5A0)
private val Red = Color(0xFFFF8585)

class MainActivity : ComponentActivity() {
    private val walletCallback = mutableStateOf<Uri?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        walletCallback.value = intent?.data
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Ink) {
                    AptidoApp(
                        walletCallback = walletCallback,
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        walletCallback.value = intent.data
    }
}

private enum class AptidoStage { AUTH, PIN, APP }
private data class ChatLine(val fromUser: Boolean, val text: String)
private data class DownloadApp(val name: String, val category: String, val description: String, val url: String)
private data class AssetLine(
    val symbol: String,
    val network: String,
    val amount: String,
    val verified: Boolean
)

private data class WalletSummaryLine(
    val id: String,
    val name: String,
    val walletNumber: String,
    val active: Boolean,
    val hasLocalWallet: Boolean,
    val backupConfirmed: Boolean
)

private data class WalletAddressLine(
    val network: String,
    val address: String,
    val label: String,
    val ownershipVerified: Boolean
)

private class AptidoApi {
    private val baseUrl = BuildConfig.API_BASE_URL.trimEnd('/')

    suspend fun get(path: String, bearer: String): JSONObject =
        withContext(Dispatchers.IO) { request(path, "GET", null, bearer) }

    suspend fun post(path: String, body: JSONObject, bearer: String? = null): JSONObject =
        withContext(Dispatchers.IO) { request(path, "POST", body, bearer) }

    suspend fun delete(path: String, bearer: String): JSONObject =
        withContext(Dispatchers.IO) { request(path, "DELETE", null, bearer) }

    private fun request(path: String, method: String, body: JSONObject?, bearer: String?): JSONObject {
        val connection = URL(baseUrl + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 12_000
            connection.readTimeout = 45_000
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-store")
            if (!bearer.isNullOrBlank()) {
                connection.setRequestProperty("Authorization", "Bearer $bearer")
            }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { stream ->
                    stream.write(body.toString().toByteArray(StandardCharsets.UTF_8))
                }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            val payload = try {
                JSONObject(raw.ifBlank { "{}" })
            } catch (_: Exception) {
                JSONObject()
            }
            if (status !in 200..299) {
                val detail = payload.optString("detail").ifBlank {
                    payload.optString("message").ifBlank { "The server returned HTTP $status." }
                }
                throw IllegalStateException(detail)
            }
            return payload
        } catch (error: IllegalStateException) {
            throw error
        } catch (_: Exception) {
            throw IllegalStateException("Could not reach BALMZ AI services. Check your internet connection and try again.")
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * Tokens are encrypted with an AES-GCM key held in Android Keystore.
 * Neither the identity token nor the wallet-PIN session token is stored as plaintext.
 */
private class SecureSessionStore(context: android.content.Context) {
    private val prefs = context.getSharedPreferences("aptido_secure_session", android.content.Context.MODE_PRIVATE)
    private val alias = "balmz_ai_apt_session_aes_v1"

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(alias, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    fun put(name: String, value: String) {
        if (value.isBlank()) {
            prefs.edit().remove(name).apply()
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        val combined = cipher.iv + encrypted
        prefs.edit().putString(name, Base64.encodeToString(combined, Base64.NO_WRAP)).apply()
    }

    fun get(name: String): String {
        val encoded = prefs.getString(name, null) ?: return ""
        return try {
            val combined = Base64.decode(encoded, Base64.NO_WRAP)
            require(combined.size > 12)
            val iv = combined.copyOfRange(0, 12)
            val encrypted = combined.copyOfRange(12, combined.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            prefs.edit().remove(name).apply()
            ""
        }
    }

    fun clearSession() {
        // Sign-out removes session credentials but preserves encrypted local wallets and chat history.
        prefs.edit().remove("auth").remove("pin").apply()
    }
}

@Composable
private fun AptidoApp(
    walletCallback: MutableState<Uri?>
) {
    val context = LocalContext.current
    val api = remember { AptidoApi() }
    val store = remember { SecureSessionStore(context) }
    val scope = rememberCoroutineScope()

    var stage by remember { mutableStateOf(AptidoStage.AUTH) }
    var authToken by remember { mutableStateOf(store.get("auth")) }
    var pinToken by remember { mutableStateOf(store.get("pin")) }
    var pinConfigured by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf("") }
    var wallet by remember { mutableStateOf(JSONObject()) }
    var walletDirectory by remember { mutableStateOf<List<WalletSummaryLine>>(emptyList()) }
    var walletAddresses by remember { mutableStateOf<List<WalletAddressLine>>(emptyList()) }
    var walletDirectoryMessage by remember { mutableStateOf("Wallet list has not been loaded yet.") }
    var walletDirectoryBusy by remember { mutableStateOf(false) }
    var verifiedAssets by remember { mutableStateOf<List<AssetLine>>(emptyList()) }
    var balanceMessage by remember { mutableStateOf("Live balance checks have not been requested yet.") }
    var balanceBusy by remember { mutableStateOf(false) }
    var chat by remember { mutableStateOf(listOf<ChatLine>()) }
    var activeEmail by remember { mutableStateOf("") }
    var verificationEmail by remember { mutableStateOf("") }
    var pendingRecoveryPhrase by remember { mutableStateOf("") }
    var pendingRecoveryWalletId by remember { mutableStateOf("") }
    var pendingRecoveryAddresses by remember { mutableStateOf<List<SelfCustodyAddress>>(emptyList()) }
    var externalWalletAccounts by remember { mutableStateOf<List<ExternalWalletAccount>>(emptyList()) }
    var externalWalletProofs by remember { mutableStateOf<List<PendingExternalWalletProof>>(emptyList()) }
    var externalWalletNotice by remember { mutableStateOf("") }
    var externalWalletBridgeUrl by remember { mutableStateOf("") }
    var bankConnectMessage by remember { mutableStateOf("Open private services to buy supported crypto or review US bank transfer availability.") }
    var bankConnectBusy by remember { mutableStateOf(false) }
    var coinbaseOnrampEnabled by remember { mutableStateOf(false) }
    var coinbaseOnrampStatus by remember { mutableStateOf("Checking Coinbase Onramp configuration…") }
    var usBankTransferStatus by remember { mutableStateOf("US bank payouts are disabled pending provider approval.") }
    var privateServicesStatusBusy by remember { mutableStateOf(false) }

    fun persistConversation() {
        if (activeEmail.isBlank()) return
        val rows = JSONArray()
        chat.forEach { rows.put(JSONObject().put("from_user", it.fromUser).put("text", it.text)) }
        store.put("chat_" + activeEmail.lowercase(), rows.toString())
    }

    fun loadExternalWalletAccounts(walletId: String): List<ExternalWalletAccount> {
        if (walletId.isBlank()) return emptyList()
        val raw = store.get("external_wallet_accounts_" + walletId)
        if (raw.isBlank()) return emptyList()
        return try {
            val rows = JSONArray(raw)
            (0 until rows.length()).mapNotNull { index ->
                rows.optJSONObject(index)?.let(ExternalWalletAccount::fromJson)
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun saveExternalWalletAccounts(walletId: String, accounts: List<ExternalWalletAccount>) {
        if (walletId.isBlank()) return
        val rows = JSONArray()
        accounts.forEach { rows.put(it.toJson()) }
        store.put("external_wallet_accounts_" + walletId, rows.toString())
    }

    fun loadExternalWalletProofs(walletId: String): List<PendingExternalWalletProof> {
        if (walletId.isBlank()) return emptyList()
        val raw = store.get("external_wallet_proofs_" + walletId)
        if (raw.isBlank()) return emptyList()
        return try {
            val rows = JSONArray(raw)
            (0 until rows.length()).mapNotNull { index ->
                rows.optJSONObject(index)?.let(PendingExternalWalletProof::fromJson)
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun saveExternalWalletProofs(walletId: String, proofs: List<PendingExternalWalletProof>) {
        if (walletId.isBlank()) return
        val rows = JSONArray()
        proofs.forEach { rows.put(it.toJson()) }
        store.put("external_wallet_proofs_" + walletId, rows.toString())
        externalWalletProofs = proofs
    }

    fun copyExternalBridgeUrl() {
        val value = externalWalletBridgeUrl
        if (value.isBlank()) {
            externalWalletNotice = "Create a Binance connection or proof link first."
            return
        }
        val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
            as? android.content.ClipboardManager
        clipboard?.setPrimaryClip(android.content.ClipData.newPlainText("BALMZ AI APT wallet link", value))
        externalWalletNotice = "Link copied. Open Binance Web3 Wallet → DApp Browser and paste it there. The bridge endpoint must be deployed before the link can load."
    }

    fun startBinanceConnect() {
        val activeId = wallet.optJSONObject("wallet")?.optString("wallet_id").orEmpty()
        if (activeId.isBlank()) {
            externalWalletNotice = "Create or select a wallet profile before linking Binance."
            return
        }
        val nonce = BinanceWalletBridge.newNonce()
        store.put(
            "aptido_external_pending_connect",
            JSONObject().put("nonce", nonce).put("wallet_id", activeId).put("created_at", System.currentTimeMillis()).toString()
        )
        externalWalletBridgeUrl = BinanceWalletBridge.connectUrl(nonce)
        externalWalletNotice = "Connection link prepared. Copy it, then open it inside Binance Web3 Wallet → DApp Browser. Do not open it in ordinary Chrome."
    }

    fun startBinanceOwnershipProof(proof: PendingExternalWalletProof) {
        val activeId = wallet.optJSONObject("wallet")?.optString("wallet_id").orEmpty()
        if (activeId.isBlank() || activeId != proof.walletId) {
            externalWalletNotice = "Switch back to the wallet profile that owns this address before signing."
            return
        }
        try {
            val nonce = BinanceWalletBridge.newNonce()
            store.put(
                "aptido_external_pending_verify",
                proof.toJson().put("nonce", nonce).put("created_at", System.currentTimeMillis()).toString()
            )
            externalWalletBridgeUrl = BinanceWalletBridge.verifyUrl(
                nonce, proof.chainId, proof.address, proof.challengeId, proof.message
            )
            externalWalletNotice = "Ownership proof link prepared for ${proof.network}. Copy it and open it inside Binance Web3 Wallet → DApp Browser. Review the exact message before approving the signature."
        } catch (error: Exception) {
            externalWalletNotice = error.message ?: "Could not prepare the ownership proof link."
        }
    }

    suspend fun checkPinStatus(identityToken: String) {
        val status = api.get("/api/v1/security/pin/status", identityToken)
        pinConfigured = status.optBoolean("pin_configured", false)
        stage = AptidoStage.PIN
    }

    suspend fun refreshWalletDirectory(sessionToken: String) {
        if (sessionToken.isBlank()) return
        walletDirectoryBusy = true
        try {
            val result = api.get("/api/v1/wallets", sessionToken)
            val rows = result.optJSONArray("wallets") ?: JSONArray()
            walletDirectory = (0 until rows.length()).mapNotNull { index ->
                val item = rows.optJSONObject(index) ?: return@mapNotNull null
                val id = item.optString("id")
                if (id.isBlank()) return@mapNotNull null
                WalletSummaryLine(
                    id = id,
                    name = item.optString("name", "Wallet"),
                    walletNumber = item.optString("wallet_number", "Not assigned"),
                    active = item.optBoolean("active", false),
                    hasLocalWallet = store.get("selfcustody_wallet_" + id).isNotBlank(),
                    backupConfirmed = store.get("selfcustody_backup_" + id) == "yes"
                )
            }
            val activeId = result.optString("active_wallet_id")
                .ifBlank { wallet.optJSONObject("wallet")?.optString("wallet_id").orEmpty() }
            externalWalletAccounts = loadExternalWalletAccounts(activeId)
            externalWalletProofs = loadExternalWalletProofs(activeId)
            if (activeId.isBlank()) {
                walletAddresses = emptyList()
                walletDirectoryMessage = "No active wallet profile is available."
            } else {
                val addressResult = api.get("/api/v1/wallets/" + activeId + "/addresses", sessionToken)
                val addressRows = addressResult.optJSONArray("addresses") ?: JSONArray()
                walletAddresses = (0 until addressRows.length()).mapNotNull { index ->
                    val item = addressRows.optJSONObject(index) ?: return@mapNotNull null
                    val address = item.optString("address")
                    if (address.isBlank()) return@mapNotNull null
                    WalletAddressLine(
                        network = item.optString("network"),
                        address = address,
                        label = item.optString("label", "primary"),
                        ownershipVerified = item.optBoolean("ownership_verified", false)
                    )
                }
                walletDirectoryMessage = if (walletAddresses.isEmpty()) {
                    "Wallet profile loaded. No public network addresses are attached yet."
                } else {
                    walletAddresses.size.toString() + " attached network address(es) loaded. Ownership status is shown per address."
                }
            }
        } catch (error: Exception) {
            walletDirectoryMessage = error.message ?: "Wallet information could not be loaded."
        } finally {
            walletDirectoryBusy = false
        }
    }

    suspend fun handleExternalWalletCallback(uri: Uri) {
        val callback = BinanceWalletBridge.parseCallback(uri)
        when (callback.mode) {
            "connected" -> {
                val rawPending = store.get("aptido_external_pending_connect")
                require(rawPending.isNotBlank()) { "No Binance connection request is waiting for a return." }
                val pending = JSONObject(rawPending)
                require(pending.optString("nonce").equals(callback.nonce, ignoreCase = true)) {
                    "This Binance connection link is expired or has already been used."
                }
                require(BinanceWalletBridge.isFreshRequest(pending.optLong("created_at"))) {
                    store.put("aptido_external_pending_connect", "")
                    "This Binance connection request has expired. Start a new connection."
                }
                val walletId = pending.optString("wallet_id")
                val activeId = wallet.optJSONObject("wallet")?.optString("wallet_id").orEmpty()
                require(walletId.isNotBlank() && walletId == activeId) {
                    "The active wallet changed while Binance was open. Start the connection again."
                }
                store.put("aptido_external_pending_connect", "")
                val network = BinanceWalletBridge.networkFor(callback.chainId)
                // Keep an existing backend label and verification state if this address
                // was already attached through another provider or a self-custody wallet.
                val attachedResult = api.get("/api/v1/wallets/" + walletId + "/addresses", pinToken)
                val attachedRows = attachedResult.optJSONArray("addresses") ?: JSONArray()
                val existingAddress = (0 until attachedRows.length())
                    .mapNotNull { attachedRows.optJSONObject(it) }
                    .firstOrNull {
                        it.optString("network") == network &&
                            it.optString("address").equals(callback.address, ignoreCase = true)
                    }
                val addressAlreadyVerified = existingAddress?.optBoolean("ownership_verified", false) ?: false
                if (existingAddress == null) {
                    api.post(
                        "/api/v1/wallets/" + walletId + "/addresses",
                        JSONObject()
                            .put("network", network)
                            .put("address", callback.address)
                            .put("label", "Binance Web3 Wallet"),
                        pinToken
                    )
                }
                val current = loadExternalWalletAccounts(walletId)
                val account = ExternalWalletAccount(
                    provider = "binance",
                    namespace = "eip155",
                    chainId = callback.chainId,
                    network = network,
                    address = callback.address,
                    connectedAt = System.currentTimeMillis(),
                    ownershipVerified = addressAlreadyVerified
                )
                val updated = current.filterNot {
                    it.provider == account.provider && it.namespace == account.namespace &&
                        it.chainId == account.chainId && it.address.equals(account.address, ignoreCase = true)
                } + account
                saveExternalWalletAccounts(walletId, updated)
                externalWalletAccounts = updated
                if (addressAlreadyVerified) {
                    externalWalletNotice = "Binance ${network} address is already ownership-verified by World Wallet AI."
                } else {
                    try {
                        val challenge = api.post(
                            "/api/v1/wallets/" + walletId + "/addresses/challenge",
                            JSONObject().put("network", network).put("address", callback.address),
                            pinToken
                        )
                        val proof = PendingExternalWalletProof(
                            walletId = walletId,
                            network = network,
                            chainId = callback.chainId,
                            address = callback.address,
                            challengeId = challenge.optString("challenge_id"),
                            message = challenge.optString("message")
                        )
                        require(proof.challengeId.isNotBlank() && proof.message.isNotBlank()) {
                            "The backend did not return a complete ownership challenge."
                        }
                        val proofs = loadExternalWalletProofs(walletId)
                            .filterNot { it.network == network && it.address.equals(callback.address, ignoreCase = true) } + proof
                        saveExternalWalletProofs(walletId, proofs)
                        externalWalletNotice = "Binance ${network} address attached. Ownership is not verified yet; sign the backend challenge to complete linking."
                    } catch (error: Exception) {
                        externalWalletNotice = "Binance address attached but ownership challenge could not be prepared: ${error.message ?: "service error"}. Refresh and reconnect to request a new proof."
                    }
                }
                refreshWalletDirectory(pinToken)
            }
            "verified" -> {
                val rawPending = store.get("aptido_external_pending_verify")
                require(rawPending.isNotBlank()) { "No Binance ownership proof is waiting for a return." }
                val pending = JSONObject(rawPending)
                require(pending.optString("nonce").equals(callback.nonce, ignoreCase = true)) {
                    "This ownership proof link is expired or has already been used."
                }
                require(BinanceWalletBridge.isFreshRequest(pending.optLong("created_at"))) {
                    store.put("aptido_external_pending_verify", "")
                    "This ownership proof request has expired. Request a new proof."
                }
                val proof = PendingExternalWalletProof.fromJson(pending)
                    ?: throw IllegalStateException("The saved ownership challenge is incomplete.")
                require(callback.challengeId == proof.challengeId &&
                    callback.chainId == proof.chainId &&
                    callback.address.equals(proof.address, ignoreCase = true)
                ) { "The returned signature does not match the pending address, network or challenge." }
                val activeId = wallet.optJSONObject("wallet")?.optString("wallet_id").orEmpty()
                require(activeId == proof.walletId) { "The active wallet changed. Select the correct wallet and retry." }
                store.put("aptido_external_pending_verify", "")
                api.post(
                    "/api/v1/wallets/" + proof.walletId + "/addresses/verify",
                    JSONObject().put("challenge_id", proof.challengeId).put("signature", callback.signature),
                    pinToken
                )
                val verifiedAccounts = loadExternalWalletAccounts(proof.walletId).map { item ->
                    if (item.provider == "binance" && item.chainId == proof.chainId &&
                        item.address.equals(proof.address, ignoreCase = true)
                    ) item.copy(ownershipVerified = true) else item
                }
                saveExternalWalletAccounts(proof.walletId, verifiedAccounts)
                externalWalletAccounts = verifiedAccounts
                val remaining = loadExternalWalletProofs(proof.walletId).filterNot {
                    it.challengeId == proof.challengeId
                }
                saveExternalWalletProofs(proof.walletId, remaining)
                externalWalletNotice = "Binance ${proof.network} address ownership is verified by World Wallet AI."
                refreshWalletDirectory(pinToken)
            }
            else -> throw IllegalStateException("Unsupported Binance callback.")
        }
    }

    suspend fun refreshWallet(sessionToken: String) {
        val result = api.get("/api/v1/wallet", sessionToken)
        wallet = result
        activeEmail = result.optJSONObject("user")?.optString("email").orEmpty().lowercase()
        if (activeEmail.isNotBlank()) {
            val savedChat = store.get("chat_" + activeEmail)
            if (savedChat.isNotBlank()) {
                try {
                    val rows = JSONArray(savedChat)
                    chat = (0 until rows.length()).mapNotNull { index ->
                        val row = rows.optJSONObject(index) ?: return@mapNotNull null
                        ChatLine(row.optBoolean("from_user"), row.optString("text"))
                    }
                } catch (_: Exception) {
                    chat = emptyList()
                }
            }
        }
        pinToken = sessionToken
        store.put("pin", sessionToken)
        stage = AptidoStage.APP
        balanceMessage = "Recorded wallet data is loaded. Live verification is separate."
        refreshWalletDirectory(sessionToken)
    }

    suspend fun createSelfCustodyWalletProfile(name: String, recoveryPhrase: String? = null) {
        require(name.isNotBlank()) { "Enter a name for this wallet." }
        walletDirectoryMessage = if (recoveryPhrase.isNullOrBlank()) {
            "Generating a new self-custody wallet securely on this device…"
        } else {
            "Validating and restoring the recovery phrase on this device…"
        }
        val generated = withContext(Dispatchers.Default) {
            if (recoveryPhrase.isNullOrBlank()) {
                TrustWalletCoreWallet.create()
            } else {
                TrustWalletCoreWallet.restore(recoveryPhrase)
            }
        }
        val response = api.post(
            "/api/v1/wallets",
            JSONObject().put("name", name.trim()),
            pinToken
        )
        val createdWallet = response.optJSONObject("wallet") ?: JSONObject()
        val walletId = createdWallet.optString("id")
        require(walletId.isNotBlank()) { "The backend created no wallet ID. The recovery phrase remains local to this device." }

        val addressRows = JSONArray()
        generated.addresses.forEach { entry ->
            addressRows.put(JSONObject().put("network", entry.network).put("address", entry.address))
        }
        val material = JSONObject()
            .put("mnemonic", generated.mnemonic)
            .put("addresses", addressRows)
            .put("created_at", System.currentTimeMillis())
        // SecureSessionStore encrypts the recovery material using an Android Keystore AES-GCM key.
        // Only public addresses are ever sent to the World Wallet AI backend.
        store.put("selfcustody_wallet_" + walletId, material.toString())
        store.put("selfcustody_backup_" + walletId, "no")

        pendingRecoveryWalletId = walletId
        pendingRecoveryPhrase = generated.mnemonic
        pendingRecoveryAddresses = generated.addresses
        refreshWallet(pinToken)
        walletDirectoryMessage =
            "A self-custody wallet was generated on this device. Back up its recovery phrase before its public addresses are attached."
    }

    fun showWalletRecoveryPhrase(walletId: String) {
        try {
            val raw = store.get("selfcustody_wallet_" + walletId)
            require(raw.isNotBlank()) { "This device has no encrypted recovery material for that wallet." }
            val material = JSONObject(raw)
            val rows = material.optJSONArray("addresses") ?: JSONArray()
            val restoredAddresses = (0 until rows.length()).mapNotNull { index ->
                val item = rows.optJSONObject(index) ?: return@mapNotNull null
                val network = item.optString("network")
                val address = item.optString("address")
                if (network.isBlank() || address.isBlank()) return@mapNotNull null
                SelfCustodyAddress(network, address)
            }
            require(restoredAddresses.size == 6) { "The saved wallet record is incomplete. Do not use it to receive funds." }
            val phrase = material.optString("mnemonic")
            require(phrase.isNotBlank()) { "The encrypted recovery phrase is missing." }
            pendingRecoveryWalletId = walletId
            pendingRecoveryPhrase = phrase
            pendingRecoveryAddresses = restoredAddresses
        } catch (error: Exception) {
            walletDirectoryMessage = error.message ?: "The recovery phrase could not be opened."
        }
    }

    suspend fun refreshVerifiedBalances() {
        if (pinToken.isBlank()) return
        balanceBusy = true
        balanceMessage = ""
        try {
            val result = api.get("/api/v1/wallet/balance-verification", pinToken)
            val rows = result.optJSONArray("assets") ?: JSONArray()
            val parsed = mutableListOf<AssetLine>()
            for (index in 0 until rows.length()) {
                val item = rows.optJSONObject(index) ?: continue
                val verified = item.optBoolean("verified", false)
                val balance = if (verified && !item.isNull("available_balance")) {
                    item.opt("available_balance").toString()
                } else {
                    "Unavailable"
                }
                parsed.add(
                    AssetLine(
                        symbol = item.optString("asset", "Asset"),
                        network = item.optString("network_label", item.optString("network", "Network unavailable")),
                        amount = balance,
                        verified = verified
                    )
                )
            }
            verifiedAssets = parsed
            val warnings = result.optJSONArray("warnings")
            balanceMessage = when {
                parsed.isEmpty() -> "The API returned no verified asset rows. This does not mean the wallet balance is zero."
                warnings != null && warnings.length() > 0 -> "Some network checks failed. Unavailable values are not shown as zero."
                parsed.none { it.verified } -> "No asset balance was verified by the network providers."
                else -> "Verification results are from the connected network providers. Unverified entries remain unavailable."
            }
        } catch (error: Exception) {
            verifiedAssets = emptyList()
            balanceMessage = error.message ?: "Live balance verification is unavailable."
        } finally {
            balanceBusy = false
        }
    }

    suspend fun acceptIdentity(response: JSONObject) {
        val token = response.optString("access_token")
        if (token.isBlank()) throw IllegalStateException("The authentication service did not return a session token.")
        authToken = token
        pinToken = ""
        store.put("auth", token)
        store.put("pin", "")
        checkPinStatus(token)
    }

    suspend fun acceptPin(pin: String) {
        if (pin.length != 6 || pin.any { !it.isDigit() }) {
            throw IllegalStateException("Enter all six digits of your wallet PIN.")
        }
        val path = if (pinConfigured) "/api/v1/security/pin/verify" else "/api/v1/security/pin/enroll"
        val result = api.post(path, JSONObject().put("pin", pin), authToken)
        val session = result.optString("access_token")
        if (session.isBlank()) throw IllegalStateException("The server did not create a wallet session.")
        refreshWallet(session)
        refreshVerifiedBalances()
    }


    suspend fun refreshPrivateServicesStatus() {
        privateServicesStatusBusy = true
        try {
            val crypto = api.get("/api/v1/bankconnect/crypto/status", pinToken)
            coinbaseOnrampEnabled = crypto.optBoolean("enabled", false)
            coinbaseOnrampStatus = when {
                coinbaseOnrampEnabled -> "Coinbase Onramp is enabled in " + crypto.optString("environment", "configured") + " mode. Coinbase controls region and payment eligibility."
                !crypto.optBoolean("configured", false) -> "Coinbase Onramp is not configured. Add the CDP key name and EC private-key secret to Render."
                else -> "Coinbase credentials are present, but Onramp is disabled. Complete provider approval and explicitly enable it on Render."
            }
        } catch (error: Exception) {
            coinbaseOnrampEnabled = false
            coinbaseOnrampStatus = error.message ?: "Coinbase Onramp status could not be checked."
        }
        try {
            val transfers = api.get("/api/v1/bankconnect/transfers/status", pinToken)
            usBankTransferStatus = transfers.optString(
                "message",
                "US bank payouts remain disabled until Nium approves the program and funding model."
            )
        } catch (error: Exception) {
            usBankTransferStatus = error.message ?: "US bank transfer status could not be checked."
        } finally {
            privateServicesStatusBusy = false
        }
    }

    LaunchedEffect(walletCallback.value, pinToken, stage) {
        val returnedUri = walletCallback.value
        if (returnedUri != null && pinToken.isNotBlank() && stage == AptidoStage.APP) {
            walletCallback.value = null
            try {
                handleExternalWalletCallback(returnedUri)
            } catch (error: Exception) {
                externalWalletNotice = error.message ?: "The Binance wallet return could not be processed."
                walletDirectoryMessage = externalWalletNotice
            }
        }
    }

    LaunchedEffect(Unit) {
        if (authToken.isNotBlank()) {
            try {
                if (pinToken.isNotBlank()) {
                    try {
                        refreshWallet(pinToken)
                        refreshVerifiedBalances()
                    } catch (_: Exception) {
                        pinToken = ""
                        store.put("pin", "")
                        checkPinStatus(authToken)
                    }
                } else {
                    checkPinStatus(authToken)
                }
            } catch (error: Exception) {
                authToken = ""
                pinToken = ""
                store.clearSession()
                notice = error.message ?: "Your saved session could not be restored. Please sign in again."
                stage = AptidoStage.AUTH
            }
        }
    }

    when (stage) {
        AptidoStage.AUTH -> AuthScreen(
            busy = busy,
            notice = notice,
            verificationEmail = verificationEmail,
            onVerify = { email, otp ->
                scope.launch {
                    busy = true
                    notice = ""
                    try {
                        val result = api.post(
                            "/api/v1/auth/neon/verify-email",
                            JSONObject().put("email", email.trim()).put("otp", otp.trim())
                        )
                        acceptIdentity(result)
                        verificationEmail = ""
                    } catch (error: Exception) {
                        notice = error.message ?: "Email verification failed."
                    } finally {
                        busy = false
                    }
                }
            },
            onCancelVerification = {
                verificationEmail = ""
                notice = ""
            },
            onResendVerification = { email ->
                scope.launch {
                    busy = true
                    notice = ""
                    try {
                        val result = api.post(
                            "/api/v1/auth/neon/resend-verification",
                            JSONObject().put("email", email.trim())
                        )
                        notice = result.optString("message", "A new verification code has been sent.")
                    } catch (error: Exception) {
                        notice = error.message ?: "Could not resend the verification code."
                    } finally {
                        busy = false
                    }
                }
            },
            onStartVerification = { email ->
                verificationEmail = email.trim()
                notice = "Enter the code already sent to your email, or request a new code."
            },
            onLogin = { email, password ->
                scope.launch {
                    busy = true
                    notice = ""
                    try {
                        val result = api.post(
                            "/api/v1/auth/neon/password",
                            JSONObject().put("email", email.trim()).put("password", password)
                        )
                        acceptIdentity(result)
                    } catch (error: Exception) {
                        notice = error.message ?: "Sign-in failed."
                    } finally {
                        busy = false
                    }
                }
            },
            onRegister = { name, email, password ->
                scope.launch {
                    busy = true
                    notice = ""
                    try {
                        val result = api.post(
                            "/api/v1/auth/neon/register",
                            JSONObject()
                                .put("name", name.trim())
                                .put("email", email.trim())
                                .put("password", password)
                        )
                        if (result.optBoolean("verification_required", false)) {
                            verificationEmail = result.optString("email", email.trim())
                            notice = result.optString("message", "Check your email for a verification code.")
                        } else {
                            acceptIdentity(result)
                        }
                    } catch (error: Exception) {
                        notice = error.message ?: "Account creation failed."
                    } finally {
                        busy = false
                    }
                }
            },
            onReset = { email ->
                scope.launch {
                    busy = true
                    notice = ""
                    try {
                        val result = api.post(
                            "/api/v1/auth/neon/password/reset/request",
                            JSONObject().put("email", email.trim())
                        )
                        notice = result.optString("message", "Check your email for a password reset link.")
                    } catch (error: Exception) {
                        notice = error.message ?: "Could not request a password reset."
                    } finally {
                        busy = false
                    }
                }
            }
        )

        AptidoStage.PIN -> PinScreen(
            configured = pinConfigured,
            busy = busy,
            notice = notice,
            onSubmit = { pin ->
                scope.launch {
                    busy = true
                    notice = ""
                    try {
                        acceptPin(pin)
                    } catch (error: Exception) {
                        notice = error.message ?: "Wallet PIN verification failed."
                    } finally {
                        busy = false
                    }
                }
            },
            onBack = {
                store.clearSession()
                authToken = ""
                pinToken = ""
                stage = AptidoStage.AUTH
                notice = ""
            }
        )

        AptidoStage.APP -> AppHome(
            wallet = wallet,
            pendingRecoveryPhrase = pendingRecoveryPhrase,
            onConfirmWalletBackup = {
                scope.launch {
                    val walletId = pendingRecoveryWalletId
                    if (walletId.isBlank()) {
                        walletDirectoryMessage = "No wallet is waiting for backup confirmation."
                        return@launch
                    }
                    try {
                        require(pendingRecoveryPhrase.isNotBlank()) { "The recovery phrase is not available." }
                        store.put("selfcustody_backup_" + walletId, "yes")
                        pendingRecoveryAddresses.forEach { entry ->
                            api.post(
                                "/api/v1/wallets/" + walletId + "/addresses",
                                JSONObject()
                                    .put("network", entry.network)
                                    .put("address", entry.address)
                                    .put("label", "primary"),
                                pinToken
                            )
                        }
                        walletDirectoryMessage =
                            "Recovery backup acknowledged. Public addresses are attached; ownership still requires network signature verification."
                        pendingRecoveryPhrase = ""
                        pendingRecoveryWalletId = ""
                        pendingRecoveryAddresses = emptyList()
                        refreshWalletDirectory(pinToken)
                    } catch (error: Exception) {
                        walletDirectoryMessage =
                            "Backup acknowledgement is saved locally. Address attachment needs a retry: " +
                                (error.message ?: "network error")
                        refreshWalletDirectory(pinToken)
                    }
                }
            },
            onDismissWalletBackup = {
                pendingRecoveryPhrase = ""
                pendingRecoveryWalletId = ""
                pendingRecoveryAddresses = emptyList()
            },
            onShowWalletRecoveryPhrase = { walletId -> showWalletRecoveryPhrase(walletId) },
            onRestoreWallet = { name, phrase ->
                scope.launch {
                    walletDirectoryBusy = true
                    try {
                        createSelfCustodyWalletProfile(name, phrase)
                    } catch (error: Exception) {
                        walletDirectoryMessage = error.message ?: "Wallet restoration failed."
                    } finally {
                        walletDirectoryBusy = false
                    }
                }
            },
            walletDirectory = walletDirectory,
            walletAddresses = walletAddresses,
            walletDirectoryMessage = walletDirectoryMessage,
            walletDirectoryBusy = walletDirectoryBusy,
            onRefreshWalletDirectory = {
                scope.launch { refreshWalletDirectory(pinToken) }
            },
            onCreateWalletProfile = { name ->
                scope.launch {
                    walletDirectoryBusy = true
                    try {
                        createSelfCustodyWalletProfile(name)
                    } catch (error: Exception) {
                        walletDirectoryMessage = error.message ?: "Self-custody wallet creation failed."
                    } finally {
                        walletDirectoryBusy = false
                    }
                }
            },
            onSwitchWalletProfile = { walletId ->
                scope.launch {
                    try {
                        api.post(
                            "/api/v1/wallets/active",
                            JSONObject().put("wallet_id", walletId),
                            pinToken
                        )
                        refreshWallet(pinToken)
                        refreshWalletDirectory(pinToken)
                        refreshVerifiedBalances()
                    } catch (error: Exception) {
                        walletDirectoryMessage = error.message ?: "Wallet profile could not be switched."
                    }
                }
            },
            onAttachPublicAddress = { networks, address ->
                scope.launch {
                    val activeId = wallet.optJSONObject("wallet")?.optString("wallet_id").orEmpty()
                    if (activeId.isBlank()) {
                        walletDirectoryMessage = "There is no active wallet profile to attach this address to."
                    } else {
                        try {
                            networks.distinct().forEach { network ->
                                api.post(
                                    "/api/v1/wallets/" + activeId + "/addresses",
                                    JSONObject()
                                        .put("network", network)
                                        .put("address", address.trim())
                                        .put("label", "primary"),
                                    pinToken
                                )
                            }
                            refreshWalletDirectory(pinToken)
                            walletDirectoryMessage = "Public address attached. Ownership remains unverified until a valid network signature is completed."
                        } catch (error: Exception) {
                            refreshWalletDirectory(pinToken)
                            walletDirectoryMessage = error.message ?: "Address attachment failed."
                        }
                    }
                }
            },
            externalWalletAccounts = externalWalletAccounts,
            externalWalletProofs = externalWalletProofs,
            externalWalletNotice = externalWalletNotice,
            externalWalletBridgeUrl = externalWalletBridgeUrl,
            onStartBinanceConnect = { startBinanceConnect() },
            onCopyExternalBridgeUrl = { copyExternalBridgeUrl() },
            onStartBinanceOwnershipProof = { proof -> startBinanceOwnershipProof(proof) },
            verifiedAssets = verifiedAssets,
            balanceMessage = balanceMessage,
            balanceBusy = balanceBusy,
            chat = chat,
            chatBusy = busy,
            onRefreshBalances = {
                scope.launch { refreshVerifiedBalances() }
            },
            bankConnectMessage = bankConnectMessage,
            bankConnectBusy = bankConnectBusy,
            coinbaseOnrampEnabled = coinbaseOnrampEnabled,
            coinbaseOnrampStatus = coinbaseOnrampStatus,
            usBankTransferStatus = usBankTransferStatus,
            privateServicesStatusBusy = privateServicesStatusBusy,
            onRefreshPrivateServicesStatus = { scope.launch { refreshPrivateServicesStatus() } },
            onBuyCrypto = { asset, network, address ->
                scope.launch {
                    bankConnectBusy = true
                    bankConnectMessage = "Preparing a secure Coinbase purchase session…"
                    try {
                        val result = api.post(
                            "/api/v1/bankconnect/crypto/buy-session",
                            JSONObject()
                                .put("asset", asset)
                                .put("network", network)
                                .put("address", address),
                            pinToken
                        )
                        val checkoutUrl = result.optString("checkout_url").trim()
                        val allowed = checkoutUrl.startsWith("https://pay.coinbase.com/") ||
                            checkoutUrl.startsWith("https://pay-sandbox.coinbase.com/")
                        if (!allowed) throw IllegalStateException("The crypto provider returned an invalid checkout address.")
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(checkoutUrl)))
                        bankConnectMessage = "Coinbase secure checkout opened for $asset. Finish payment and identity checks with Coinbase."
                    } catch (error: Exception) {
                        bankConnectMessage = error.message ?: "Could not open the crypto purchase flow."
                    } finally {
                        bankConnectBusy = false
                    }
                }
            },
            onAsk = { question, includeWallet ->
                scope.launch {
                    if (question.isBlank() || busy) return@launch
                    chat = chat + ChatLine(true, question.trim())
                    persistConversation()
                    busy = true
                    try {
                        val response = api.post(
                            "/api/v1/balmz-ai/ask",
                            JSONObject()
                                .put("question", question.trim())
                                .put("include_wallet_context", includeWallet),
                            pinToken
                        )
                        val answer = response.optString("answer")
                        if (answer.isBlank()) {
                            chat = chat + ChatLine(false, "The AI service returned an empty response. Please try again.")
                            persistConversation()
                        } else {
                            chat = chat + ChatLine(false, answer)
                            persistConversation()
                        }
                    } catch (error: Exception) {
                        chat = chat + ChatLine(false, "I couldn't complete that request: " + (error.message ?: "AI service unavailable"))
                        persistConversation()
                    } finally {
                        busy = false
                    }
                }
            },
            onLogout = {
                scope.launch {
                    try {
                        if (pinToken.isNotBlank()) {
                            api.post("/api/v1/security/pin/lock", JSONObject(), pinToken)
                        }
                    } catch (_: Exception) {
                        // Local credentials are still cleared even when offline.
                    }
                    store.clearSession()
                    store.put("aptido_external_pending_connect", "")
                    store.put("aptido_external_pending_verify", "")
                    authToken = ""
                    pinToken = ""
                    wallet = JSONObject()
                    verifiedAssets = emptyList()
                    chat = emptyList()
                    activeEmail = ""
                    notice = ""
                    stage = AptidoStage.AUTH
                }
            }
        )
    }
}

@Composable
private fun AuthScreen(
    busy: Boolean,
    notice: String,
    verificationEmail: String,
    onVerify: (String, String) -> Unit,
    onCancelVerification: () -> Unit,
    onResendVerification: (String) -> Unit,
    onStartVerification: (String) -> Unit,
    onLogin: (String, String) -> Unit,
    onRegister: (String, String, String) -> Unit,
    onReset: (String) -> Unit
) {
    var createAccount by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var verificationCode by remember { mutableStateOf("") }

    if (verificationEmail.isNotBlank()) {
        Column(
            modifier = Modifier.fillMaxSize().background(Ink).imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.Center
        ) {
            Text("BALMZ AI APT", color = Orange, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(18.dp))
            Text("Verify your email", color = Paper, fontSize = 27.sp, fontWeight = FontWeight.Bold)
            Text("Enter the verification code sent to $verificationEmail. Your wallet session will be created after Neon confirms the code.", color = Muted, fontSize = 14.sp)
            Spacer(Modifier.height(20.dp))
            AptidoField(verificationCode, { verificationCode = it.filter { ch -> ch.isDigit() }.take(12) }, "Email verification code", keyboard = KeyboardType.Number)
            if (notice.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(notice, color = if (notice.contains("sent", true)) Green else Red, fontSize = 12.sp)
            }
            Spacer(Modifier.height(14.dp))
            Button(
                onClick = { onVerify(verificationEmail, verificationCode) },
                enabled = !busy && verificationCode.length in 4..12,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
            ) {
                if (busy) CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Ink, strokeWidth = 2.dp)
                else Text("Verify email", fontWeight = FontWeight.Bold)
            }
            TextButton(onClick = { onResendVerification(verificationEmail) }, enabled = !busy, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                Text("Resend verification code", color = Orange)
            }
            TextButton(onClick = onCancelVerification, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                Text("Back to sign in", color = Paper)
            }
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().background(Ink).imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp, vertical = 26.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("BALMZ", color = Orange, fontSize = 15.sp, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)
        Text("AI APT", color = Paper, fontSize = 36.sp, fontWeight = FontWeight.ExtraBold)
        Text("Your intelligent workspace, in your pocket.", color = Muted, fontSize = 14.sp)
        Spacer(Modifier.height(24.dp))
        Column(
            modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(24.dp)).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(if (createAccount) "Create your account" else "Welcome back", color = Paper, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text(
                if (createAccount) "Create an individual account with your email address and password."
                else "Sign in with your existing World Wallet AI account.",
                color = Muted, fontSize = 13.sp
            )
            if (createAccount) {
                AptidoField(name, { name = it }, "Full name")
                AptidoField(email, { email = it }, "Email address", keyboard = KeyboardType.Email)
            } else {
                AptidoField(email, { email = it }, "Email address", keyboard = KeyboardType.Email)
            }
            AptidoField(password, { password = it }, "Password", password = true)
            if (!createAccount) {
                TextButton(
                    onClick = { if (email.isNotBlank()) onReset(email) },
                    enabled = !busy && email.isNotBlank(),
                    modifier = Modifier.align(Alignment.End)
                ) { Text("Forgot password?", color = Orange) }
            }
            if (notice.isNotBlank()) {
                Text(notice, color = if (notice.contains("success", true) || notice.contains("requested", true)) Green else Red, fontSize = 12.sp)
            }
            Button(
                onClick = {
                    if (createAccount) onRegister(name, email, password)
                    else onLogin(email, password)
                },
                enabled = !busy && email.isNotBlank() && password.isNotBlank() &&
                    (!createAccount || name.isNotBlank()),
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
            ) {
                if (busy) CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Ink, strokeWidth = 2.dp)
                else Text(if (createAccount) "Create account" else "Sign in", fontWeight = FontWeight.Bold)
            }
            if (createAccount) {
                TextButton(onClick = { onStartVerification(email) }, enabled = !busy && email.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                    Text("Already signed up? Verify your email", color = Orange)
                }
            }
            TextButton(onClick = { createAccount = !createAccount }, modifier = Modifier.fillMaxWidth()) {
                Text(if (createAccount) "Already have an account? Sign in" else "New to BALMZ AI APT? Create account", color = Paper)
            }
        }
        Spacer(Modifier.height(18.dp))
        Text("Secure sign-in · Account-specific data · Powered by World Wallet AI", color = Muted, fontSize = 11.sp)
    }
}

@Composable
private fun PinScreen(
    configured: Boolean,
    busy: Boolean,
    notice: String,
    onSubmit: (String) -> Unit,
    onBack: () -> Unit
) {
    var pin by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().background(Ink).imePadding().padding(24.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("BALMZ AI APT", color = Orange, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(16.dp))
        Text(if (configured) "Unlock your wallet" else "Create your wallet PIN", color = Paper, fontSize = 27.sp, fontWeight = FontWeight.Bold)
        Text(
            if (configured) "Enter the six-digit PIN already associated with your World Wallet AI account."
            else "Set a six-digit PIN to protect wallet access on this device.",
            color = Muted, fontSize = 14.sp
        )
        Spacer(Modifier.height(20.dp))
        AptidoField(pin, { pin = it.filter { char -> char.isDigit() }.take(6) }, "Six-digit wallet PIN", keyboard = KeyboardType.Number)
        if (notice.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(notice, color = Red, fontSize = 12.sp)
        }
        Spacer(Modifier.height(14.dp))
        Button(
            onClick = { onSubmit(pin) },
            enabled = !busy && pin.length == 6,
            modifier = Modifier.fillMaxWidth().height(50.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
        ) {
            if (busy) CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Ink, strokeWidth = 2.dp)
            else Text(if (configured) "Verify PIN" else "Create PIN", fontWeight = FontWeight.Bold)
        }
        TextButton(onClick = onBack, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("Sign out", color = Paper)
        }
    }
}

@Composable
private fun AppHome(
    wallet: JSONObject,
    pendingRecoveryPhrase: String,
    onConfirmWalletBackup: () -> Unit,
    onDismissWalletBackup: () -> Unit,
    onShowWalletRecoveryPhrase: (String) -> Unit,
    onRestoreWallet: (String, String) -> Unit,
    walletDirectory: List<WalletSummaryLine>,
    walletAddresses: List<WalletAddressLine>,
    walletDirectoryMessage: String,
    walletDirectoryBusy: Boolean,
    onRefreshWalletDirectory: () -> Unit,
    onCreateWalletProfile: (String) -> Unit,
    onSwitchWalletProfile: (String) -> Unit,
    bankConnectMessage: String,
    bankConnectBusy: Boolean,
    coinbaseOnrampEnabled: Boolean,
    coinbaseOnrampStatus: String,
    usBankTransferStatus: String,
    privateServicesStatusBusy: Boolean,
    onRefreshPrivateServicesStatus: () -> Unit,
    onBuyCrypto: (String, String, String) -> Unit,
    onAttachPublicAddress: (List<String>, String) -> Unit,
    externalWalletAccounts: List<ExternalWalletAccount>,
    externalWalletProofs: List<PendingExternalWalletProof>,
    externalWalletNotice: String,
    externalWalletBridgeUrl: String,
    onStartBinanceConnect: () -> Unit,
    onCopyExternalBridgeUrl: () -> Unit,
    onStartBinanceOwnershipProof: (PendingExternalWalletProof) -> Unit,
    verifiedAssets: List<AssetLine>,
    balanceMessage: String,
    balanceBusy: Boolean,
    chat: List<ChatLine>,
    chatBusy: Boolean,
    onRefreshBalances: () -> Unit,
    onAsk: (String, Boolean) -> Unit,
    onLogout: () -> Unit
) {
    var tab by remember { mutableStateOf("Home") }
    var includeWallet by remember { mutableStateOf(false) }
    var question by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxSize().background(Ink).padding(bottom = 8.dp)) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
            Text("BALMZ", color = Orange, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text("AI APT", color = Paper, fontSize = 27.sp, fontWeight = FontWeight.ExtraBold)
                Text("LIVE API", color = Green, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            listOf("Home", "Wallets", "More", "AI Chat", "Downloads", "Account").forEach { item ->
                val selected = tab == item
                Box(
                    modifier = Modifier.width(82.dp).background(if (selected) Orange else Panel, RoundedCornerShape(12.dp))
                        .clickable { tab = item }.padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(item, color = if (selected) Ink else Paper, fontWeight = FontWeight.SemiBold, fontSize = 11.sp)
                }
            }
        }
        when (tab) {
            "Home" -> HomePanel(
                wallet = wallet,
                verifiedAssets = verifiedAssets,
                balanceMessage = balanceMessage,
                balanceBusy = balanceBusy,
                onRefreshBalances = onRefreshBalances,
                onNavigate = { destination -> tab = destination }
            )
            "Wallets" -> WalletsPanel(
                wallets = walletDirectory,
                addresses = walletAddresses,
                message = walletDirectoryMessage,
                busy = walletDirectoryBusy,
                onRefresh = onRefreshWalletDirectory,
                onCreateWalletProfile = onCreateWalletProfile,
                onSwitchWalletProfile = onSwitchWalletProfile,
                onAttachPublicAddress = onAttachPublicAddress,
                externalWalletAccounts = externalWalletAccounts,
                externalWalletProofs = externalWalletProofs,
                externalWalletNotice = externalWalletNotice,
                externalWalletBridgeUrl = externalWalletBridgeUrl,
                onStartBinanceConnect = onStartBinanceConnect,
                onCopyExternalBridgeUrl = onCopyExternalBridgeUrl,
                onStartBinanceOwnershipProof = onStartBinanceOwnershipProof,
                onShowRecoveryPhrase = onShowWalletRecoveryPhrase,
                onRestoreWallet = onRestoreWallet
            )
            "More" -> BankConnectPanel(
                walletAddresses = walletAddresses,
                message = bankConnectMessage,
                busy = bankConnectBusy,
                coinbaseOnrampEnabled = coinbaseOnrampEnabled,
                coinbaseOnrampStatus = coinbaseOnrampStatus,
                usBankTransferStatus = usBankTransferStatus,
                statusBusy = privateServicesStatusBusy,
                onRefreshStatus = onRefreshPrivateServicesStatus,
                onBuyCrypto = onBuyCrypto
            )
            "AI Chat" -> ChatPanel(
                messages = chat,
                busy = chatBusy,
                question = question,
                onQuestionChange = { question = it },
                includeWallet = includeWallet,
                onIncludeWalletChange = { includeWallet = it },
                onSend = {
                    val message = question.trim()
                    if (message.isNotBlank() && !chatBusy) {
                        question = ""
                        onAsk(message, includeWallet)
                    }
                }
            )
            "Downloads" -> DownloadsPanel()
            else -> AccountPanel(wallet = wallet, onLogout = onLogout)
        }
        if (pendingRecoveryPhrase.isNotBlank()) {
            AlertDialog(
                onDismissRequest = onDismissWalletBackup,
                containerColor = Panel,
                title = { Text("Back up your recovery phrase", color = Paper, fontWeight = FontWeight.Bold) },
                text = {
                    Column(
                        modifier = Modifier.verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Text(
                            "Write these recovery words down offline and keep them private. Anyone with this phrase can control the wallet. Never send it to anyone or paste it into a website.",
                            color = Muted,
                            fontSize = 12.sp
                        )
                        Text(pendingRecoveryPhrase, color = Paper, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                        Text(
                            "The phrase is encrypted in Android Keystore storage on this device. It is not sent to the backend. Public addresses are attached only after you confirm your backup.",
                            color = Muted,
                            fontSize = 11.sp
                        )
                    }
                },
                confirmButton = {
                    Button(
                        onClick = onConfirmWalletBackup,
                        colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
                    ) { Text("I have backed it up") }
                },
                dismissButton = {
                    TextButton(onClick = onDismissWalletBackup) { Text("Later", color = Paper) }
                }
            )
        }
    }
}


@Composable
private fun BankConnectPanel(
    walletAddresses: List<WalletAddressLine>,
    message: String,
    busy: Boolean,
    coinbaseOnrampEnabled: Boolean,
    coinbaseOnrampStatus: String,
    usBankTransferStatus: String,
    statusBusy: Boolean,
    onRefreshStatus: () -> Unit,
    onBuyCrypto: (String, String, String) -> Unit
) {
    var showPrivateServices by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { onRefreshStatus() }
    val supportedAddresses = walletAddresses.filter { address ->
        address.ownershipVerified && address.network in setOf("bitcoin", "ethereum", "solana_mainnet")
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("More", color = Paper, fontSize = 23.sp, fontWeight = FontWeight.Bold)
        Text("Private financial services are kept separate from your main wallet screens.", color = Muted, fontSize = 12.sp)
        TextButton(
            onClick = { showPrivateServices = !showPrivateServices },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                if (showPrivateServices) "Hide private services" else "Open private services",
                color = Orange,
                fontWeight = FontWeight.Bold
            )
        }

        if (showPrivateServices) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Buy Bitcoin and other crypto", color = Paper, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text(
                    "Choose a verified address in your active BALMZ wallet. Coinbase opens its own secure checkout; payment methods, identity checks, fees and availability are controlled by Coinbase.",
                    color = Muted,
                    fontSize = 11.sp
                )
                if (supportedAddresses.isEmpty()) {
                    InfoCard("No verified Bitcoin, Ethereum or Solana Mainnet address is ready for purchases. Open Wallets and complete the address ownership verification first.")
                } else {
                    supportedAddresses.forEach { address ->
                        val assets = when (address.network) {
                            "bitcoin" -> listOf("BTC")
                            "ethereum" -> listOf("ETH", "USDC")
                            "solana_mainnet" -> listOf("SOL")
                            else -> emptyList()
                        }
                        Column(
                            modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(14.dp)).padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                when (address.network) {
                                    "bitcoin" -> "Bitcoin Mainnet"
                                    "ethereum" -> "Ethereum Mainnet"
                                    else -> "Solana Mainnet"
                                },
                                color = Orange,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Text(address.address.take(10) + "…" + address.address.takeLast(8), color = Muted, fontSize = 10.sp)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                assets.forEach { asset ->
                                    Button(
                                        onClick = { onBuyCrypto(asset, address.network, address.address) },
                                        enabled = !busy && coinbaseOnrampEnabled,
                                        colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink),
                                        modifier = Modifier.weight(1f)
                                    ) { Text("Buy $asset", fontWeight = FontWeight.Bold, fontSize = 11.sp) }
                                }
                            }
                        }
                    }
                }
                InfoCard(coinbaseOnrampStatus)
                InfoCard("A purchase is not credited until Coinbase completes it. BALMZ does not collect bank login details or bank-issued OTPs. A US bank payment method may need to be linked and verified inside the user's Coinbase account.")
                TextButton(onClick = onRefreshStatus, enabled = !statusBusy, modifier = Modifier.fillMaxWidth()) {
                    Text(if (statusBusy) "Checking provider status…" else "Refresh provider status", color = Orange)
                }
                Divider(color = PanelLight)
                Text("Send USD to another US bank", color = Paper, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                InfoCard(usBankTransferStatus)
                InfoCard("For a program onboarded outside the United States, Nium documents US IAT payouts as next-business-day rather than same-day domestic ACH. The exact BALMZ route and eligibility still require written provider approval.")
            }
        }

        if (busy) CircularProgressIndicator(color = Orange)
        if (message.isNotBlank()) InfoCard(message)
    }
}

@Composable
private fun WalletsPanel(
    wallets: List<WalletSummaryLine>,
    addresses: List<WalletAddressLine>,
    message: String,
    busy: Boolean,
    onRefresh: () -> Unit,
    onCreateWalletProfile: (String) -> Unit,
    onSwitchWalletProfile: (String) -> Unit,
    onAttachPublicAddress: (List<String>, String) -> Unit,
    externalWalletAccounts: List<ExternalWalletAccount>,
    externalWalletProofs: List<PendingExternalWalletProof>,
    externalWalletNotice: String,
    externalWalletBridgeUrl: String,
    onStartBinanceConnect: () -> Unit,
    onCopyExternalBridgeUrl: () -> Unit,
    onStartBinanceOwnershipProof: (PendingExternalWalletProof) -> Unit,
    onShowRecoveryPhrase: (String) -> Unit,
    onRestoreWallet: (String, String) -> Unit
) {
    val context = LocalContext.current
    var walletName by remember { mutableStateOf("My Wallet") }
    var networkMode by remember { mutableStateOf("Mainnet") }
    var selectedNetwork by remember { mutableStateOf("evm_mainnets") }
    var addressInput by remember { mutableStateOf("") }
    var recoveryInput by remember { mutableStateOf("") }

    val networkChoices = if (networkMode == "Mainnet") {
        listOf(
            "Ethereum + BNB Mainnet" to "evm_mainnets",
            "Solana Mainnet" to "solana_mainnet",
            "Bitcoin Mainnet" to "bitcoin"
        )
    } else {
        listOf(
            "Ethereum Sepolia" to "sepolia",
            "Solana Devnet" to "solana_devnet"
        )
    }
    LaunchedEffect(networkMode) {
        selectedNetwork = networkChoices.first().second
    }

    val networkRows = if (networkMode == "Mainnet") {
        listOf(
            "Ethereum Mainnet" to "ethereum",
            "BNB Chain Mainnet" to "bnb",
            "Solana Mainnet" to "solana_mainnet",
            "Bitcoin Mainnet" to "bitcoin"
        )
    } else {
        listOf(
            "Ethereum Sepolia" to "sepolia",
            "Solana Devnet" to "solana_devnet"
        )
    }

    Column(
        modifier = Modifier.fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Wallets", color = Paper, fontSize = 23.sp, fontWeight = FontWeight.Bold)
                Text("Wallet profiles, network addresses and connection status", color = Muted, fontSize = 11.sp)
            }
            Button(
                onClick = onRefresh,
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = PanelLight, contentColor = Paper)
            ) { Text("Refresh", fontSize = 11.sp) }
        }

        Text("Your wallet profiles", color = Paper, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        if (wallets.isEmpty()) {
            InfoCard("No wallet profiles were returned by the account API.")
        } else {
            wallets.forEach { item ->
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .background(Panel, RoundedCornerShape(14.dp))
                        .padding(13.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(item.name, color = Paper, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        Text("Wallet ID: " + item.walletNumber, color = Muted, fontSize = 11.sp)
                        if (item.active) {
                            Text("ACTIVE WALLET", color = Green, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        }
                        if (item.hasLocalWallet) {
                            Text(
                                if (item.backupConfirmed) "SELF-CUSTODY · BACKUP ACKNOWLEDGED" else "SELF-CUSTODY · BACKUP NOT CONFIRMED",
                                color = if (item.backupConfirmed) Green else Orange,
                                fontSize = 9.sp,
                                fontWeight = FontWeight.Bold
                            )
                            TextButton(onClick = { onShowRecoveryPhrase(item.id) }) {
                                Text("View recovery phrase", color = Orange, fontSize = 10.sp)
                            }
                        }
                    }
                    if (!item.active) {
                        Button(
                            onClick = { onSwitchWalletProfile(item.id) },
                            enabled = !busy,
                            colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
                        ) { Text("Switch", fontSize = 11.sp) }
                    }
                }
            }
        }

        Text("Network addresses", color = Paper, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "Mainnet and testnet addresses are kept separate. One EVM account can use the same public address on Ethereum and BNB Chain; Solana and Bitcoin have separate address formats.",
            color = Muted,
            fontSize = 11.sp
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Mainnet", "Testnet").forEach { mode ->
                val selected = networkMode == mode
                Box(
                    modifier = Modifier.background(if (selected) Orange else Panel, RoundedCornerShape(18.dp))
                        .clickable { networkMode = mode }
                        .padding(horizontal = 16.dp, vertical = 9.dp)
                ) {
                    Text(mode, color = if (selected) Ink else Paper, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }

        networkRows.forEach { (label, network) ->
            val matches = addresses.filter { it.network == network }
            Column(
                modifier = Modifier.fillMaxWidth()
                    .background(Panel, RoundedCornerShape(14.dp))
                    .padding(13.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp)
            ) {
                Text(label, color = Paper, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                if (matches.isEmpty()) {
                    Text("No address attached", color = Muted, fontSize = 11.sp)
                } else {
                    matches.forEach { entry ->
                        Text(entry.address, color = Paper, fontSize = 11.sp)
                        Text(
                            if (entry.ownershipVerified) "Ownership verified" else "Attached · ownership proof required",
                            color = if (entry.ownershipVerified) Green else Orange,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = {
                                    val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                                        as? android.content.ClipboardManager
                                    clipboard?.setPrimaryClip(
                                        android.content.ClipData.newPlainText("Wallet address", entry.address)
                                    )
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = PanelLight, contentColor = Paper)
                            ) { Text("Copy address", fontSize = 10.sp) }
                            Text(entry.label, color = Muted, fontSize = 10.sp, modifier = Modifier.padding(top = 12.dp))
                        }
                    }
                }
            }
        }

        Text("Attach an existing public address", color = Paper, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "This links a public address to the active wallet profile. It does not import private keys, sign transactions or prove ownership. Unverified addresses remain read-only.",
            color = Muted,
            fontSize = 11.sp
        )
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(7.dp)
        ) {
            networkChoices.forEach { (label, key) ->
                val selected = selectedNetwork == key
                Box(
                    modifier = Modifier.background(if (selected) Orange else Panel, RoundedCornerShape(16.dp))
                        .clickable { selectedNetwork = key }
                        .padding(horizontal = 11.dp, vertical = 9.dp)
                ) {
                    Text(label, color = if (selected) Ink else Paper, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        OutlinedTextField(
            value = addressInput,
            onValueChange = { addressInput = it.trim() },
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            label = { Text("Public wallet address") },
            placeholder = { Text("Paste an address from your external wallet", color = Muted) },
            colors = fieldColors()
        )
        Button(
            onClick = {
                val networks = when (selectedNetwork) {
                    "evm_mainnets" -> listOf("ethereum", "bnb")
                    else -> listOf(selectedNetwork)
                }
                onAttachPublicAddress(networks, addressInput.trim())
                addressInput = ""
            },
            enabled = !busy && addressInput.trim().length >= 20,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
        ) { Text(if (busy) "Working…" else "Attach address", fontWeight = FontWeight.Bold) }

        Text("Create a self-custody wallet", color = Paper, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "Trust Wallet Core creates the recovery phrase and network keys on this device. The phrase is encrypted locally and never uploaded. Back it up before the public addresses are attached.",
            color = Muted,
            fontSize = 11.sp
        )
        OutlinedTextField(
            value = walletName,
            onValueChange = { walletName = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            label = { Text("Wallet profile name") },
            colors = fieldColors()
        )
        Button(
            onClick = { onCreateWalletProfile(walletName.trim()) },
            enabled = !busy && walletName.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = PanelLight, contentColor = Paper)
        ) { Text("Generate self-custody wallet") }

        Divider(color = PanelLight)
        Text("Restore from a recovery phrase", color = Paper, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(
            "Enter an existing 12- or 24-word BIP-39 phrase to restore addresses on this device. The phrase is validated and processed locally; it is never sent to the backend.",
            color = Muted,
            fontSize = 11.sp
        )
        OutlinedTextField(
            value = recoveryInput,
            onValueChange = { recoveryInput = it.lowercase().replace(Regex("\\s+"), " ").take(600) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 3,
            maxLines = 4,
            label = { Text("Recovery phrase") },
            placeholder = { Text("Enter your words separated by spaces", color = Muted) },
            colors = fieldColors()
        )
        Button(
            onClick = {
                val phrase = recoveryInput.trim()
                if (phrase.isNotBlank()) {
                    onRestoreWallet("Restored Wallet", phrase)
                    recoveryInput = ""
                }
            },
            enabled = !busy && recoveryInput.trim().split(Regex("\\s+")).size in listOf(12, 24),
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = PanelLight, contentColor = Paper)
        ) { Text("Restore self-custody wallet") }

        if (busy) {
            CircularProgressIndicator(color = Orange, modifier = Modifier.size(22.dp))
        }
        InfoCard(message)
    }
}

@Composable
private fun DownloadsPanel() {
    val context = LocalContext.current
    val apps = remember {
        listOf(
            DownloadApp("Google Chrome", "Browser", "Fast and secure web browsing.", "https://play.google.com/store/apps/details?id=com.android.chrome"),
            DownloadApp("Google Play Store", "Store", "Browse and install Android apps from Google.", "https://play.google.com/store"),
            DownloadApp("WhatsApp", "Messaging", "Private messaging and voice/video calls.", "https://www.whatsapp.com/android"),
            DownloadApp("Telegram", "Messaging", "Cloud-based messaging and channels.", "https://telegram.org/android"),
            DownloadApp("YouTube", "Video", "Watch videos, music and creator content.", "https://play.google.com/store/apps/details?id=com.google.android.youtube"),
            DownloadApp("Google Maps", "Utilities", "Navigation, places and directions.", "https://play.google.com/store/apps/details?id=com.google.android.apps.maps"),
            DownloadApp("Gmail", "Productivity", "Email from Google.", "https://play.google.com/store/apps/details?id=com.google.android.gm"),
            DownloadApp("Facebook", "Social", "Connect with friends and communities.", "https://www.facebook.com/mobile/"),
            DownloadApp("Instagram", "Social", "Photos, reels and messages.", "https://www.instagram.com/"),
            DownloadApp("TikTok", "Video", "Short-form videos and creator content.", "https://www.tiktok.com/download"),
            DownloadApp("Google Drive", "Productivity", "Store and share files in the cloud.", "https://play.google.com/store/apps/details?id=com.google.android.apps.docs"),
            DownloadApp("Google Photos", "Productivity", "Back up and organize photos.", "https://play.google.com/store/apps/details?id=com.google.android.apps.photos"),
            DownloadApp("Google Meet", "Communication", "Video meetings and calls.", "https://play.google.com/store/apps/details?id=com.google.android.apps.tachyon"),
            DownloadApp("Google Translate", "Utilities", "Translate text, speech and images.", "https://play.google.com/store/apps/details?id=com.google.android.apps.translate"),
            DownloadApp("Spotify", "Music", "Stream music and podcasts.", "https://www.spotify.com/download/android/"),
            DownloadApp("Microsoft Word", "Productivity", "Create and edit documents.", "https://play.google.com/store/apps/details?id=com.microsoft.office.word"),
            DownloadApp("Microsoft Excel", "Productivity", "Create and edit spreadsheets.", "https://play.google.com/store/apps/details?id=com.microsoft.office.excel"),
            DownloadApp("Microsoft Edge", "Browser", "Browse with Microsoft Edge.", "https://www.microsoft.com/edge/mobile"),
            DownloadApp("Firefox", "Browser", "Open-source web browser from Mozilla.", "https://www.mozilla.org/firefox/browsers/mobile/android/"),
            DownloadApp("Binance", "Finance", "Official Binance app download page.", "https://www.binance.com/en/download"),
            DownloadApp("Trust Wallet", "Finance", "Official self-custody wallet download page.", "https://trustwallet.com/download"),
            DownloadApp("MetaMask", "Finance", "Official MetaMask wallet download page.", "https://metamask.io/download/")
        )
    }
    val categories = listOf("All", "Browser", "Store", "Messaging", "Video", "Social", "Productivity", "Utilities", "Communication", "Music", "Finance")
    var selectedCategory by remember { mutableStateOf("All") }
    var query by remember { mutableStateOf("") }
    val filtered = apps.filter {
        (selectedCategory == "All" || it.category == selectedCategory) &&
            (query.isBlank() || it.name.contains(query, true) || it.description.contains(query, true))
    }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 10.dp)) {
        Text("App downloads", color = Paper, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text("Find trusted Android apps and open their official download pages.", color = Muted, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            placeholder = { Text("Search apps…", color = Muted) },
            colors = fieldColors()
        )
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            categories.forEach { category ->
                val selected = selectedCategory == category
                Box(
                    modifier = Modifier.background(if (selected) Orange else Panel, RoundedCornerShape(18.dp))
                        .clickable { selectedCategory = category }.padding(horizontal = 13.dp, vertical = 9.dp)
                ) {
                    Text(category, color = if (selected) Ink else Paper, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Text("${filtered.size} apps", color = Muted, fontSize = 11.sp)
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            items(filtered) { app ->
                Row(
                    modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(16.dp)).padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier.size(42.dp).background(PanelLight, RoundedCornerShape(13.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(app.name.take(1), color = Orange, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(app.name, color = Paper, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        Text(app.category, color = Orange, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                        Text(app.description, color = Muted, fontSize = 11.sp)
                    }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            runCatching {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(app.url)))
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
                    ) {
                        Text("Open", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
            if (filtered.isEmpty()) {
                item { InfoCard("No apps match your search. Try another name or category.") }
            }
            item {
                Text(
                    "Downloads open the app publisher's official page or Google Play. BALMZ AI APT does not host or modify APK files.",
                    color = Muted, fontSize = 10.sp, modifier = Modifier.padding(vertical = 8.dp)
                )
            }
        }
    }
}

@Composable
private fun HomePanel(
    wallet: JSONObject,
    verifiedAssets: List<AssetLine>,
    balanceMessage: String,
    balanceBusy: Boolean,
    onRefreshBalances: () -> Unit,
    onNavigate: (String) -> Unit
) {
    val walletObject = wallet.optJSONObject("wallet") ?: JSONObject()
    val assets = wallet.optJSONArray("assets") ?: JSONArray()
    val walletNumber = walletObject.optString("wallet_number").ifBlank { "Not assigned" }
    val user = wallet.optJSONObject("user") ?: JSONObject()
    val displayName = user.optString("name").ifBlank { "Welcome" }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Column(
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp).background(Panel, RoundedCornerShape(20.dp))
                    .clickable { onNavigate("Account") }.padding(18.dp)
            ) {
                Text(displayName, color = Muted, fontSize = 13.sp)
                Text("Your workspace", color = Paper, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(12.dp))
                Text("WALLET ID", color = Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                Text(walletNumber, color = Orange, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                Text("Values below are returned by your authenticated World Wallet AI account.", color = Muted, fontSize = 11.sp)
            }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth().clickable { onNavigate("Wallets") }) {
                Text("Wallet assets", color = Paper, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Text(assets.length().toString() + " records", color = Muted, fontSize = 11.sp)
            }
        }
        if (assets.length() == 0) {
            item { InfoCard("No wallet asset records were returned. No balance has been assumed or generated.", onClick = { onNavigate("Wallets") }) }
        } else {
            items((0 until assets.length()).mapNotNull { assets.optJSONObject(it) }) { asset ->
                val symbol = asset.optString("symbol", "Asset")
                val amount = if (asset.isNull("available_balance")) "Unavailable" else asset.opt("available_balance").toString()
                val network = asset.optString("network_label", "Network not classified")
                AssetCard(symbol, network, amount, verified = false, onClick = { onNavigate("Wallets") })
            }
        }
        item {
            Column(modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp))
                .clickable { onNavigate("Wallets") }.padding(16.dp)) {
                Text("Live balance verification", color = Paper, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Text(balanceMessage, color = Muted, fontSize = 12.sp)
                Spacer(Modifier.height(10.dp))
                Button(
                    onClick = onRefreshBalances,
                    enabled = !balanceBusy,
                    colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
                ) {
                    if (balanceBusy) CircularProgressIndicator(modifier = Modifier.size(16.dp), color = Ink, strokeWidth = 2.dp)
                    else Text("Verify live balances")
                }
            }
        }
        items(verifiedAssets) { asset ->
            AssetCard(asset.symbol, asset.network, asset.amount, asset.verified, onClick = { onNavigate("Wallets") })
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}

@Composable
private fun AssetCard(
    symbol: String,
    network: String,
    amount: String,
    verified: Boolean,
    onClick: (() -> Unit)? = null
) {
    Row(
        modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(16.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier.size(38.dp).background(PanelLight, RoundedCornerShape(13.dp)),
            contentAlignment = Alignment.Center
        ) {
            Text(symbol.take(1), color = Orange, fontWeight = FontWeight.Bold, fontSize = 17.sp)
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(symbol, color = Paper, fontWeight = FontWeight.Bold)
            Text(network, color = Muted, fontSize = 11.sp)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(amount, color = Paper, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            Text(if (verified) "Network verified" else "Ledger record", color = if (verified) Green else Muted, fontSize = 10.sp)
        }
    }
}

@Composable
private fun ChatPanel(
    messages: List<ChatLine>,
    busy: Boolean,
    question: String,
    onQuestionChange: (String) -> Unit,
    includeWallet: Boolean,
    onIncludeWalletChange: (Boolean) -> Unit,
    onSend: () -> Unit
) {
    val listState = rememberLazyListState()
    LaunchedEffect(messages.size, busy) {
        val finalIndex = messages.lastIndex
        if (finalIndex >= 0) listState.animateScrollToItem(finalIndex)
    }
    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 10.dp)) {
        Text("BALMZ AI assistant", color = Paper, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text("Answers come from the connected AI service. Wallet context is optional.", color = Muted, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (messages.isEmpty()) {
                item {
                    InfoCard("Ask a question about your account, wallet safety, networks or supported features. The assistant will not ask for your password, recovery phrase or PIN.")
                }
            }
            items(messages) { line ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = if (line.fromUser) Arrangement.End else Arrangement.Start
                ) {
                    Text(
                        line.text,
                        color = if (line.fromUser) Ink else Paper,
                        fontSize = 13.sp,
                        modifier = Modifier.fillMaxWidth(0.88f)
                            .background(if (line.fromUser) Orange else Panel, RoundedCornerShape(16.dp))
                            .padding(13.dp)
                    )
                }
            }
            if (busy) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), color = Orange, strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("BALMZ AI is responding…", color = Muted, fontSize = 12.sp)
                    }
                }
            }
        }
        Divider(color = PanelLight)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = includeWallet, onCheckedChange = onIncludeWalletChange)
            Text("Include verified wallet context", color = Muted, fontSize = 11.sp)
        }
        OutlinedTextField(
            value = question,
            onValueChange = onQuestionChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Write your message…", color = Muted) },
            maxLines = 4,
            colors = fieldColors()
        )
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = onSend,
            enabled = !busy && question.isNotBlank(),
            modifier = Modifier.fillMaxWidth().height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Orange, contentColor = Ink)
        ) { Text("Send message", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun AccountPanel(wallet: JSONObject, onLogout: () -> Unit) {
    val user = wallet.optJSONObject("user") ?: JSONObject()
    val walletObject = wallet.optJSONObject("wallet") ?: JSONObject()
    Column(
        modifier = Modifier.fillMaxSize().padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Account", color = Paper, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        InfoCard(
            "Name: " + user.optString("name", "Unavailable") +
                "\nEmail: " + user.optString("email", "Unavailable") +
                "\nWallet ID: " + walletObject.optString("wallet_number", "Not assigned")
        )
        Text("Your session is protected by the account sign-in and six-digit wallet PIN.", color = Muted, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = onLogout,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = PanelLight, contentColor = Paper)
        ) { Text("Sign out") }
        Text("BALMZ AI APT · Android application", color = Muted, fontSize = 11.sp)
    }
}

@Composable
private fun InfoCard(text: String, onClick: (() -> Unit)? = null) {
    Text(
        text,
        color = Muted,
        fontSize = 12.sp,
        modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(16.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(16.dp)
    )
}

@Composable
private fun AptidoField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    password: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        colors = fieldColors()
    )
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Paper,
    unfocusedTextColor = Paper,
    focusedBorderColor = Orange,
    unfocusedBorderColor = PanelLight,
    focusedLabelColor = Orange,
    unfocusedLabelColor = Muted,
    cursorColor = Orange
)