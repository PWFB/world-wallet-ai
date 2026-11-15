package com.balmz.aptido

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BinanceWalletBridgeTest {
    @Test
    fun connectLinkUsesOneTimeNonceAndNoCredentials() {
        val nonce = BinanceWalletBridge.newNonce()
        val uri = Uri.parse(BinanceWalletBridge.connectUrl(nonce))
        assertTrue(BinanceWalletBridge.isNonce(nonce))
        assertEquals("connect", uri.getQueryParameter("mode"))
        assertEquals(nonce, uri.getQueryParameter("nonce"))
        assertFalse(uri.toString().contains("token", ignoreCase = true))
        assertFalse(uri.toString().contains("mnemonic", ignoreCase = true))
    }

    @Test
    fun callbackAcceptsEthereumAndBnbOnly() {
        val nonce = BinanceWalletBridge.newNonce()
        val address = "0x1111111111111111111111111111111111111111"
        val ethereum = Uri.parse("balmzaptido://wallet-connect/callback?mode=connected&provider=binance&namespace=eip155&chain_id=0x1&address=$address&nonce=$nonce")
        val bnb = Uri.parse("balmzaptido://wallet-connect/callback?mode=connected&provider=binance&namespace=eip155&chain_id=0x38&address=$address&nonce=$nonce")
        assertEquals("ethereum", BinanceWalletBridge.networkFor(BinanceWalletBridge.parseCallback(ethereum).chainId))
        assertEquals("bnb", BinanceWalletBridge.networkFor(BinanceWalletBridge.parseCallback(bnb).chainId))
    }

    @Test
    fun callbackRejectsOtherSchemeAndUnsupportedChain() {
        val nonce = BinanceWalletBridge.newNonce()
        val address = "0x1111111111111111111111111111111111111111"
        val badScheme = Uri.parse("https://wallet-connect/callback?mode=connected&provider=binance&namespace=eip155&chain_id=0x1&address=$address&nonce=$nonce")
        val badChain = Uri.parse("balmzaptido://wallet-connect/callback?mode=connected&provider=binance&namespace=eip155&chain_id=0x5&address=$address&nonce=$nonce")
        assertThrows(IllegalArgumentException::class.java) { BinanceWalletBridge.parseCallback(badScheme) }
        assertThrows(IllegalArgumentException::class.java) { BinanceWalletBridge.parseCallback(badChain) }
    }

    @Test
    fun proofLinkCarriesOnlyPublicChallengeFields() {
        val nonce = BinanceWalletBridge.newNonce()
        val address = "0x1111111111111111111111111111111111111111"
        val url = BinanceWalletBridge.verifyUrl(
            nonce, "0x38", address, "wac_abcdefghijklmnop",
            "World Wallet AI address ownership verification"
        )
        assertTrue(url.contains("mode=verify"))
        assertTrue(url.contains("chain_id=0x38"))
        assertFalse(url.contains("private_key", ignoreCase = true))
        assertFalse(url.contains("access_token", ignoreCase = true))
    }
}
