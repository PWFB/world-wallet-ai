package com.balmz.aptido

import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Ink) {
                    AptidoApp()
                }
            }
        }
    }
}

private enum class AptidoStage { AUTH, PIN, APP }
private data class ChatLine(val fromUser: Boolean, val text: String)
private data class AssetLine(
    val symbol: String,
    val network: String,
    val amount: String,
    val verified: Boolean
)

private class AptidoApi {
    private val baseUrl = BuildConfig.API_BASE_URL.trimEnd('/')

    suspend fun get(path: String, bearer: String): JSONObject =
        withContext(Dispatchers.IO) { request(path, "GET", null, bearer) }

    suspend fun post(path: String, body: JSONObject, bearer: String? = null): JSONObject =
        withContext(Dispatchers.IO) { request(path, "POST", body, bearer) }

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

    fun clear() {
        prefs.edit().clear().apply()
    }
}

@Composable
private fun AptidoApp() {
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
    var verifiedAssets by remember { mutableStateOf<List<AssetLine>>(emptyList()) }
    var balanceMessage by remember { mutableStateOf("Live balance checks have not been requested yet.") }
    var balanceBusy by remember { mutableStateOf(false) }
    var chat by remember { mutableStateOf(listOf<ChatLine>()) }
    var activeEmail by remember { mutableStateOf("") }

    fun persistConversation() {
        if (activeEmail.isBlank()) return
        val rows = JSONArray()
        chat.forEach { rows.put(JSONObject().put("from_user", it.fromUser).put("text", it.text)) }
        store.put("chat_" + activeEmail.lowercase(), rows.toString())
    }

    suspend fun checkPinStatus(identityToken: String) {
        val status = api.get("/api/v1/security/pin/status", identityToken)
        pinConfigured = status.optBoolean("pin_configured", false)
        stage = AptidoStage.PIN
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
                store.clear()
                notice = error.message ?: "Your saved session could not be restored. Please sign in again."
                stage = AptidoStage.AUTH
            }
        }
    }

    when (stage) {
        AptidoStage.AUTH -> AuthScreen(
            busy = busy,
            notice = notice,
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
                        acceptIdentity(result)
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
                store.clear()
                authToken = ""
                pinToken = ""
                stage = AptidoStage.AUTH
                notice = ""
            }
        )

        AptidoStage.APP -> AppHome(
            wallet = wallet,
            verifiedAssets = verifiedAssets,
            balanceMessage = balanceMessage,
            balanceBusy = balanceBusy,
            chat = chat,
            chatBusy = busy,
            onRefreshBalances = {
                scope.launch { refreshVerifiedBalances() }
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
                    store.clear()
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
    onLogin: (String, String) -> Unit,
    onRegister: (String, String, String) -> Unit,
    onReset: (String) -> Unit
) {
    var createAccount by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

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
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            listOf("Home", "AI Chat", "Account").forEach { item ->
                val selected = tab == item
                Box(
                    modifier = Modifier.weight(1f).background(if (selected) Orange else Panel, RoundedCornerShape(12.dp))
                        .clickable { tab = item }.padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(item, color = if (selected) Ink else Paper, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                }
            }
        }
        when (tab) {
            "Home" -> HomePanel(
                wallet = wallet,
                verifiedAssets = verifiedAssets,
                balanceMessage = balanceMessage,
                balanceBusy = balanceBusy,
                onRefreshBalances = onRefreshBalances
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
            else -> AccountPanel(wallet = wallet, onLogout = onLogout)
        }
    }
}

@Composable
private fun HomePanel(
    wallet: JSONObject,
    verifiedAssets: List<AssetLine>,
    balanceMessage: String,
    balanceBusy: Boolean,
    onRefreshBalances: () -> Unit
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
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp).background(Panel, RoundedCornerShape(20.dp)).padding(18.dp)
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text("Wallet assets", color = Paper, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Text(assets.length().toString() + " records", color = Muted, fontSize = 11.sp)
            }
        }
        if (assets.length() == 0) {
            item { InfoCard("No wallet asset records were returned. No balance has been assumed or generated.") }
        } else {
            items((0 until assets.length()).mapNotNull { assets.optJSONObject(it) }) { asset ->
                val symbol = asset.optString("symbol", "Asset")
                val amount = if (asset.isNull("available_balance")) "Unavailable" else asset.opt("available_balance").toString()
                val network = asset.optString("network_label", "Network not classified")
                AssetCard(symbol, network, amount, verified = false)
            }
        }
        item {
            Column(modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(18.dp)).padding(16.dp)) {
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
            AssetCard(asset.symbol, asset.network, asset.amount, asset.verified)
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}

@Composable
private fun AssetCard(symbol: String, network: String, amount: String, verified: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(16.dp)).padding(14.dp),
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
private fun InfoCard(text: String) {
    Text(
        text,
        color = Muted,
        fontSize = 12.sp,
        modifier = Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(16.dp)).padding(16.dp)
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
