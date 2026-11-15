package com.balmz.aptido

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TrustWalletCoreDerivationTest {
    @Test
    fun derivesDistinctMainnetAndTestnetAddresses() {
        // Public BIP-39 test vector; never use this phrase to hold real funds.
        val phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        val result = TrustWalletCoreWallet.restore(phrase)
        val byNetwork = result.addresses.associate { it.network to it.address }

        assertEquals(6, byNetwork.size)
        assertEquals(byNetwork["ethereum"], byNetwork["bnb"])
        assertNotEquals(byNetwork["ethereum"], byNetwork["sepolia"])
        assertNotEquals(byNetwork["solana_mainnet"], byNetwork["solana_devnet"])
        assertTrue(byNetwork.getValue("bitcoin").startsWith("bc1"))
        assertEquals(phrase, result.mnemonic)
    }

    @Test
    fun rejectsInvalidRecoveryPhrase() {
        try {
            TrustWalletCoreWallet.restore("not a valid recovery phrase")
            throw AssertionError("An invalid BIP-39 phrase must be rejected.")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message.orEmpty().contains("valid"))
        }
    }
}
