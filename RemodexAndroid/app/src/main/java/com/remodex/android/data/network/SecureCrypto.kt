package com.remodex.android.data.network

import com.remodex.android.data.model.SECURE_HANDSHAKE_LABEL
import com.remodex.android.data.model.SECURE_HANDSHAKE_TAG
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

object SecureCrypto {
    private val secureRandom = SecureRandom()
    private val base64Encoder = Base64.getEncoder()
    private val base64Decoder = Base64.getDecoder()

    data class PhoneIdentity(
        val deviceId: String,
        val privateKey: String,
        val publicKey: String,
    )

    fun generatePhoneIdentity(): PhoneIdentity {
        val privateKey = Ed25519PrivateKeyParameters(secureRandom)
        val publicKey = privateKey.generatePublicKey()
        return PhoneIdentity(
            deviceId = UUID.randomUUID().toString(),
            privateKey = base64(privateKey.encoded),
            publicKey = base64(publicKey.encoded),
        )
    }

    fun generateEphemeralKey(): X25519PrivateKeyParameters = X25519PrivateKeyParameters(secureRandom)

    fun randomBytes(size: Int): ByteArray = ByteArray(size).also(secureRandom::nextBytes)

    fun transcriptBytes(
        sessionId: String,
        protocolVersion: Int,
        handshakeMode: String,
        keyEpoch: Int,
        macDeviceId: String,
        phoneDeviceId: String,
        macIdentityPublicKey: String,
        phoneIdentityPublicKey: String,
        macEphemeralPublicKey: String,
        phoneEphemeralPublicKey: String,
        clientNonce: ByteArray,
        serverNonce: ByteArray,
        expiresAtForTranscript: Long,
    ): ByteArray {
        return buildList<ByteArray> {
            add(lengthPrefixedUtf8(SECURE_HANDSHAKE_TAG))
            add(lengthPrefixedUtf8(sessionId))
            add(lengthPrefixedUtf8(protocolVersion.toString()))
            add(lengthPrefixedUtf8(handshakeMode))
            add(lengthPrefixedUtf8(keyEpoch.toString()))
            add(lengthPrefixedUtf8(macDeviceId))
            add(lengthPrefixedUtf8(phoneDeviceId))
            add(lengthPrefixedData(decodeBase64(macIdentityPublicKey)))
            add(lengthPrefixedData(decodeBase64(phoneIdentityPublicKey)))
            add(lengthPrefixedData(decodeBase64(macEphemeralPublicKey)))
            add(lengthPrefixedData(decodeBase64(phoneEphemeralPublicKey)))
            add(lengthPrefixedData(clientNonce))
            add(lengthPrefixedData(serverNonce))
            add(lengthPrefixedUtf8(expiresAtForTranscript.toString()))
        }.fold(ByteArray(0)) { acc, part -> acc + part }
    }

    fun clientAuthTranscript(transcriptBytes: ByteArray): ByteArray {
        return transcriptBytes + lengthPrefixedUtf8(SECURE_HANDSHAKE_LABEL)
    }

    fun signEd25519(privateKeyBase64: String, message: ByteArray): String {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(decodeBase64(privateKeyBase64), 0))
        signer.update(message, 0, message.size)
        return base64(signer.generateSignature())
    }

    fun verifyEd25519(publicKeyBase64: String, message: ByteArray, signatureBase64: String): Boolean {
        val signer = Ed25519Signer()
        signer.init(false, Ed25519PublicKeyParameters(decodeBase64(publicKeyBase64), 0))
        signer.update(message, 0, message.size)
        return signer.verifySignature(decodeBase64(signatureBase64))
    }

    fun sharedSecret(privateKey: X25519PrivateKeyParameters, publicKeyBase64: String): ByteArray {
        val secret = ByteArray(32)
        privateKey.generateSecret(X25519PublicKeyParameters(decodeBase64(publicKeyBase64), 0), secret, 0)
        return secret
    }

    fun hkdfSha256(
        ikm: ByteArray,
        salt: ByteArray,
        info: ByteArray,
        outputSize: Int,
    ): ByteArray {
        val extractMac = Mac.getInstance("HmacSHA256")
        extractMac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = extractMac.doFinal(ikm)

        val result = ByteArray(outputSize)
        var previous = ByteArray(0)
        var generated = 0
        var counter = 1
        while (generated < outputSize) {
            val expandMac = Mac.getInstance("HmacSHA256")
            expandMac.init(SecretKeySpec(prk, "HmacSHA256"))
            expandMac.update(previous)
            expandMac.update(info)
            expandMac.update(counter.toByte())
            previous = expandMac.doFinal()
            val copyLength = minOf(previous.size, outputSize - generated)
            previous.copyInto(result, generated, 0, copyLength)
            generated += copyLength
            counter += 1
        }
        return result
    }

    fun secureNonce(sender: String, counter: Int): ByteArray {
        val nonce = ByteArray(12)
        nonce[0] = if (sender == "mac") 1 else 2
        var remaining = counter.toLong()
        for (index in 11 downTo 1) {
            nonce[index] = (remaining and 0xff).toByte()
            remaining = remaining shr 8
        }
        return nonce
    }

    fun encryptAesGcm(key: ByteArray, nonce: ByteArray, plaintext: ByteArray): Pair<String, String> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, nonce),
        )
        val combined = cipher.doFinal(plaintext)
        val ciphertext = combined.copyOfRange(0, combined.size - 16)
        val tag = combined.copyOfRange(combined.size - 16, combined.size)
        return base64(ciphertext) to base64(tag)
    }

    fun decryptAesGcm(
        key: ByteArray,
        nonce: ByteArray,
        ciphertextBase64: String,
        tagBase64: String,
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, nonce),
        )
        val ciphertext = decodeBase64(ciphertextBase64)
        val tag = decodeBase64(tagBase64)
        return cipher.doFinal(ciphertext + tag)
    }

    fun fingerprint(publicKeyBase64: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(decodeBase64(publicKeyBase64))
        return digest.take(6).joinToString(":") { "%02x".format(it) }
    }

    fun base64(data: ByteArray): String = base64Encoder.encodeToString(data)

    fun decodeBase64(value: String): ByteArray = base64Decoder.decode(value)

    private fun lengthPrefixedUtf8(value: String): ByteArray = lengthPrefixedData(value.toByteArray(Charsets.UTF_8))

    private fun lengthPrefixedData(value: ByteArray): ByteArray {
        return ByteBuffer.allocate(4 + value.size)
            .putInt(value.size)
            .put(value)
            .array()
    }
}
