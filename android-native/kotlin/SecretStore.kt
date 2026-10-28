package com.ark.arkpm

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Contraseñas y claves privadas cifradas con AES-GCM; la clave vive en el Android Keystore y nunca sale de él. */
object SecretStore {
    private const val ALIAS = "arkpm_secrets"
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("arkpm_secrets", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        kg.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return kg.generateKey()
    }

    fun save(ctx: Context, id: String, value: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs(ctx).edit().putString(id, Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)).apply()
    }

    /** null si no hay nada guardado o la clave del Keystore se perdió (p. ej. tras restaurar una copia): se vuelve a pedir. */
    fun load(ctx: Context, id: String): String? {
        val raw = prefs(ctx).getString(id, null) ?: return null
        return try {
            val (iv, ct) = raw.split(":").map { Base64.decode(it, Base64.NO_WRAP) }
            val c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(c.doFinal(ct), Charsets.UTF_8)
        } catch (_: Throwable) { null }
    }

    fun delete(ctx: Context, id: String) { prefs(ctx).edit().remove(id).apply() }
}
