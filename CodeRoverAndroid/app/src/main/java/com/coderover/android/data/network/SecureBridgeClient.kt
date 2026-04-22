package com.coderover.android.data.network

import android.util.Log
import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.ConnectionPhase
import com.coderover.android.data.model.HandshakeMode
import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.PhoneIdentityState
import com.coderover.android.data.model.SECURE_PROTOCOL_VERSION
import com.coderover.android.data.model.SecureConnectionState
import com.coderover.android.data.model.TrustedMacRecord
import com.coderover.android.data.model.jsonObjectOrNull
import com.coderover.android.data.model.responseKey
import com.coderover.android.data.model.string
import kotlinx.serialization.json.*
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class CodeRoverServiceException(
    val code: Int,
    override val message: String,
    val data: JsonObject? = null,
) : Exception(message)

class SecureBridgeClient(
    private val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    },
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val onNotification: suspend (method: String, params: JsonObject?) -> Unit,
    private val onApprovalRequest: suspend (id: JsonElement, method: String, params: JsonObject?) -> Unit,
    private val onDisconnected: suspend (Throwable?) -> Unit,
    private val onSecureStateChanged: suspend (SecureConnectionState, String?) -> Unit,
    private val onBridgeSequenceApplied: suspend (Int) -> Unit,
    private val onTrustedMacConfirmed: suspend (TrustedMacRecord) -> Unit,
) {
    private companion object {
        const val TAG = "SecureBridgeClient"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessionMutex = Mutex()
    private val pendingResponses = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()
    private val bufferedControls = mutableMapOf<String, ArrayDeque<JsonObject>>()
    private val controlWaiters = mutableMapOf<String, ArrayDeque<CompletableDeferred<JsonObject>>>()

    private var socket: WebSocket? = null
    private var secureSession: SecureSession? = null
    private var phoneIdentity: PhoneIdentityState? = null
    private var currentAccessMode: AccessMode = AccessMode.ON_REQUEST
    private var lastSentBridgeAckSeq: Int = 0
    private var pendingBridgeAckSeq: Int? = null
    private var bridgeAckFlushJob: Job? = null

    suspend fun connect(
        url: String,
        pairingRecord: PairingRecord,
        phoneIdentityState: PhoneIdentityState,
        trustedMacRecord: TrustedMacRecord?,
        accessMode: AccessMode,
    ): ConnectedSession {
        currentAccessMode = accessMode
        phoneIdentity = phoneIdentityState
        secureSession = null
        lastSentBridgeAckSeq = pairingRecord.lastAppliedBridgeOutboundSeq
        pendingBridgeAckSeq = null
        bridgeAckFlushJob?.cancel()
        bridgeAckFlushJob = null
        val openSignal = CompletableDeferred<Unit>()
        val request = Request.Builder().url(url).build()

        socket = httpClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.d(TAG, "onOpen code=${response.code} url=$url")
                    openSignal.complete(Unit)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    scope.launch {
                        handleIncomingWireText(text)
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(TAG, "onClosing code=$code reason=$reason")
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(TAG, "onClosed code=$code reason=$reason")
                    scope.launch {
                        failPending(IllegalStateException("Connection closed: $reason"))
                        onDisconnected(null)
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.e(TAG, "onFailure code=${response?.code}", t)
                    scope.launch {
                        failPending(t)
                        onDisconnected(t)
                    }
                }
            },
        )

        withTimeout(12_000) {
            openSignal.await()
        }
        Log.d(TAG, "socket open acknowledged url=$url")

        val handshakeMode = if (trustedMacRecord != null) {
            HandshakeMode.TRUSTED_RECONNECT
        } else {
            HandshakeMode.QR_BOOTSTRAP
        }
        Log.d(TAG, "starting handshake mode=$handshakeMode mac=${pairingRecord.macDeviceId}")
        onSecureStateChanged(
            if (handshakeMode == HandshakeMode.TRUSTED_RECONNECT) {
                SecureConnectionState.RECONNECTING
            } else {
                SecureConnectionState.HANDSHAKING
            },
            null,
        )

        val expectedMacKey = trustedMacRecord?.macIdentityPublicKey ?: pairingRecord.macIdentityPublicKey
        val handshake = performHandshake(
            pairingRecord = pairingRecord,
            phoneIdentityState = phoneIdentityState,
            expectedMacIdentityKey = expectedMacKey,
            handshakeMode = handshakeMode,
            lastAppliedBridgeOutboundSeq = pairingRecord.lastAppliedBridgeOutboundSeq,
        )

        if (handshakeMode == HandshakeMode.QR_BOOTSTRAP) {
            onTrustedMacConfirmed(
                TrustedMacRecord(
                    macDeviceId = pairingRecord.macDeviceId,
                    macIdentityPublicKey = handshake.macIdentityPublicKey,
                    lastPairedAt = System.currentTimeMillis(),
                ),
            )
        }

        onSecureStateChanged(SecureConnectionState.ENCRYPTED, handshake.fingerprint)
        return handshake
    }

    suspend fun disconnect() {
        sessionMutex.withLock {
            secureSession = null
            socket?.close(1000, "client disconnect")
            socket = null
            bufferedControls.clear()
            controlWaiters.clear()
        }
        bridgeAckFlushJob?.cancel()
        bridgeAckFlushJob = null
        pendingBridgeAckSeq = null
    }

    suspend fun sendRequest(method: String, params: JsonObject?): JsonElement? {
        val id = JsonPrimitive(java.util.UUID.randomUUID().toString())
        val responseDeferred = CompletableDeferred<JsonObject>()
        pendingResponses[responseKey(id)] = responseDeferred
        sendRpcMessage(
            JsonObject(
                buildMap {
                    put("id", id)
                    put("method", JsonPrimitive(method))
                    if (params != null) {
                        put("params", params)
                    }
                },
            ),
        )
        val response = withTimeout(20_000) { responseDeferred.await() }
        response["error"]?.jsonObjectOrNull()?.let { errorObj ->
            throw CodeRoverServiceException(
                code = errorObj["code"]?.jsonPrimitive?.int ?: -1,
                message = errorObj["message"]?.jsonPrimitive?.content ?: "Unknown RPC error",
                data = errorObj["data"]?.jsonObjectOrNull(),
            )
        }
        return response["result"]
    }

    suspend fun sendNotification(method: String, params: JsonObject?) {
        sendRpcMessage(
            JsonObject(
                buildMap {
                    put("method", JsonPrimitive(method))
                    if (params != null) {
                        put("params", params)
                    }
                },
            ),
        )
    }

    suspend fun sendResponse(id: JsonElement, result: JsonElement) {
        sendRpcMessage(
            JsonObject(
                mapOf(
                    "id" to id,
                    "result" to result,
                ),
            ),
        )
    }

    suspend fun sendErrorResponse(id: JsonElement?, code: Int, message: String) {
        sendRpcMessage(
            JsonObject(
                buildMap {
                    if (id != null) {
                        put("id", id)
                    } else {
                        put("id", JsonNull)
                    }
                    put(
                        "error",
                        JsonObject(
                            mapOf(
                                "code" to JsonPrimitive(code),
                                "message" to JsonPrimitive(message),
                            ),
                        ),
                    )
                },
            ),
        )
    }

    private suspend fun performHandshake(
        pairingRecord: PairingRecord,
        phoneIdentityState: PhoneIdentityState,
        expectedMacIdentityKey: String,
        handshakeMode: HandshakeMode,
        lastAppliedBridgeOutboundSeq: Int,
    ): ConnectedSession {
        val phoneEphemeralPrivateKey = SecureCrypto.generateEphemeralKey()
        val phoneEphemeralPublicKey = SecureCrypto.base64(phoneEphemeralPrivateKey.generatePublicKey().encoded)
        val clientNonce = SecureCrypto.randomBytes(32)
        sendRawControl(
            JsonObject(
                mapOf(
                    "kind" to JsonPrimitive("clientHello"),
                    "protocolVersion" to JsonPrimitive(SECURE_PROTOCOL_VERSION),
                    "sessionId" to JsonPrimitive(pairingRecord.bridgeId),
                    "handshakeMode" to JsonPrimitive(handshakeMode.rawValue),
                    "phoneDeviceId" to JsonPrimitive(phoneIdentityState.phoneDeviceId),
                    "phoneIdentityPublicKey" to JsonPrimitive(phoneIdentityState.phoneIdentityPublicKey),
                    "phoneEphemeralPublicKey" to JsonPrimitive(phoneEphemeralPublicKey),
                    "clientNonce" to JsonPrimitive(SecureCrypto.base64(clientNonce)),
                ),
            ),
        )

        val serverHello = awaitControl("serverHello")
        val serverSessionId = serverHello.string("sessionId")
            ?: error("Secure handshake is missing sessionId")
        require(serverSessionId == pairingRecord.bridgeId) {
            "Secure handshake returned the wrong bridge session."
        }

        val serverMacDeviceId = serverHello.string("macDeviceId")
            ?: error("Secure handshake is missing macDeviceId")
        require(serverMacDeviceId == pairingRecord.macDeviceId) {
            "Secure handshake returned the wrong Mac device."
        }

        val macIdentityPublicKey = serverHello.string("macIdentityPublicKey")
            ?: error("Secure handshake is missing mac identity key")
        require(macIdentityPublicKey == expectedMacIdentityKey) {
            "Secure Mac identity does not match the paired device."
        }

        val serverNonceBase64 = serverHello.string("serverNonce")
            ?: error("Secure handshake is missing the server nonce")
        val serverNonce = SecureCrypto.decodeBase64(serverNonceBase64)
        val keyEpoch = serverHello["keyEpoch"]?.let { (it as? JsonPrimitive)?.intOrNull } ?: 1
        val expiresAtForTranscript = serverHello["expiresAtForTranscript"]?.let { (it as? JsonPrimitive)?.longOrNull } ?: 0L
        val transcript = SecureCrypto.transcriptBytes(
            sessionId = pairingRecord.bridgeId,
            protocolVersion = SECURE_PROTOCOL_VERSION,
            handshakeMode = handshakeMode.rawValue,
            keyEpoch = keyEpoch,
            macDeviceId = serverMacDeviceId,
            phoneDeviceId = phoneIdentityState.phoneDeviceId,
            macIdentityPublicKey = macIdentityPublicKey,
            phoneIdentityPublicKey = phoneIdentityState.phoneIdentityPublicKey,
            macEphemeralPublicKey = serverHello.string("macEphemeralPublicKey").orEmpty(),
            phoneEphemeralPublicKey = phoneEphemeralPublicKey,
            clientNonce = clientNonce,
            serverNonce = serverNonce,
            expiresAtForTranscript = expiresAtForTranscript,
        )
        val serverSignature = serverHello.string("macSignature")
            ?: error("Secure handshake is missing the server signature")
        require(SecureCrypto.verifyEd25519(macIdentityPublicKey, transcript, serverSignature)) {
            "Unable to verify the secure Mac signature."
        }

        val clientAuthSignature = SecureCrypto.signEd25519(
            privateKeyBase64 = phoneIdentityState.phoneIdentityPrivateKey,
            message = SecureCrypto.clientAuthTranscript(transcript),
        )
        sendRawControl(
            JsonObject(
                mapOf(
                    "kind" to JsonPrimitive("clientAuth"),
                    "sessionId" to JsonPrimitive(pairingRecord.bridgeId),
                    "phoneDeviceId" to JsonPrimitive(phoneIdentityState.phoneDeviceId),
                    "keyEpoch" to JsonPrimitive(keyEpoch),
                    "phoneSignature" to JsonPrimitive(clientAuthSignature),
                ),
            ),
        )

        awaitControl("secureReady")
        val sharedSecret = SecureCrypto.sharedSecret(
            privateKey = phoneEphemeralPrivateKey,
            publicKeyBase64 = serverHello.string("macEphemeralPublicKey").orEmpty(),
        )
        val salt = java.security.MessageDigest.getInstance("SHA-256").digest(transcript)
        val infoPrefix = "${com.coderover.android.data.model.SECURE_HANDSHAKE_TAG}|${pairingRecord.bridgeId}|${pairingRecord.macDeviceId}|${phoneIdentityState.phoneDeviceId}|$keyEpoch"
        val phoneToMacKey = SecureCrypto.hkdfSha256(
            ikm = sharedSecret,
            salt = salt,
            info = "$infoPrefix|phoneToMac".toByteArray(),
            outputSize = 32,
        )
        val macToPhoneKey = SecureCrypto.hkdfSha256(
            ikm = sharedSecret,
            salt = salt,
            info = "$infoPrefix|macToPhone".toByteArray(),
            outputSize = 32,
        )

        sessionMutex.withLock {
            secureSession = SecureSession(
                sessionId = pairingRecord.bridgeId,
                keyEpoch = keyEpoch,
                macDeviceId = pairingRecord.macDeviceId,
                macIdentityPublicKey = macIdentityPublicKey,
                phoneToMacKey = phoneToMacKey,
                macToPhoneKey = macToPhoneKey,
                lastInboundBridgeOutboundSeq = lastAppliedBridgeOutboundSeq,
                lastInboundCounter = -1,
                nextOutboundCounter = 0,
            )
        }

        sendRawControl(
            JsonObject(
                mapOf(
                    "kind" to JsonPrimitive("resumeState"),
                    "sessionId" to JsonPrimitive(pairingRecord.bridgeId),
                    "keyEpoch" to JsonPrimitive(keyEpoch),
                    "lastAppliedBridgeOutboundSeq" to JsonPrimitive(lastAppliedBridgeOutboundSeq),
                ),
            ),
        )

        return ConnectedSession(
            macIdentityPublicKey = macIdentityPublicKey,
            fingerprint = SecureCrypto.fingerprint(macIdentityPublicKey),
        )
    }

    private suspend fun awaitControl(kind: String): JsonObject {
        bufferedControls["secureError"]?.removeFirstOrNull()?.let { secureError ->
            val message = secureError.string("message") ?: "Secure bridge error"
            throw IllegalStateException(message)
        }

        bufferedControls[kind]?.removeFirstOrNull()?.let { return it }
        val waiter = CompletableDeferred<JsonObject>()
        controlWaiters.getOrPut(kind) { ArrayDeque() }.addLast(waiter)
        return withTimeout(12_000) { waiter.await() }
    }

    private suspend fun handleIncomingWireText(text: String) {
        val parsed = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (parsed.string("kind")) {
            "serverHello", "secureReady", "secureError" -> {
                deliverControl(parsed)
            }

            "encryptedEnvelope" -> {
                handleEncryptedEnvelope(parsed)
            }

            else -> {
                handleIncomingPlainRpc(parsed)
            }
        }
    }

    private fun deliverControl(message: JsonObject) {
        val kind = message.string("kind") ?: return
        val waiter = controlWaiters[kind]?.removeFirstOrNull()
        if (waiter != null) {
            waiter.complete(message)
        } else {
            bufferedControls.getOrPut(kind) { ArrayDeque() }.addLast(message)
        }
    }

    private suspend fun handleEncryptedEnvelope(envelope: JsonObject) {
        val session = sessionMutex.withLock { secureSession } ?: return
        if (envelope.string("sessionId") != session.sessionId) {
            return
        }
        val counter = envelope["counter"]?.let { (it as? JsonPrimitive)?.intOrNull } ?: return
        if (counter <= session.lastInboundCounter) {
            return
        }
        val plaintext = SecureCrypto.decryptAesGcm(
            key = session.macToPhoneKey,
            nonce = SecureCrypto.secureNonce("mac", counter),
            ciphertextBase64 = envelope.string("ciphertext").orEmpty(),
            tagBase64 = envelope.string("tag").orEmpty(),
        )
        val payload = runCatching { json.parseToJsonElement(plaintext.decodeToString()).jsonObject }.getOrNull() ?: return
        val bridgeOutboundSeq = payload["bridgeOutboundSeq"]?.let { (it as? JsonPrimitive)?.intOrNull }
        if (bridgeOutboundSeq != null && bridgeOutboundSeq > session.lastInboundBridgeOutboundSeq) {
            session.lastInboundBridgeOutboundSeq = bridgeOutboundSeq
            onBridgeSequenceApplied(bridgeOutboundSeq)
            scheduleBridgeReplayAck(bridgeOutboundSeq)
        }
        session.lastInboundCounter = counter
        sessionMutex.withLock {
            secureSession = session
        }
        val payloadText = payload.string("payloadText") ?: return
        val rpcObject = runCatching { json.parseToJsonElement(payloadText).jsonObject }.getOrNull() ?: return
        handleIncomingPlainRpc(rpcObject)
    }

    private suspend fun handleIncomingPlainRpc(message: JsonObject) {
        val method = message.string("method")
        val id = message["id"]
        if (method != null) {
            val params = message["params"]?.let { it as? JsonObject }
            if (id != null && id !is JsonNull) {
                if (
                    method == "item/commandExecution/requestApproval" ||
                    method == "item/fileChange/requestApproval" ||
                    method.endsWith("requestApproval") ||
                    method == "item/tool/requestUserInput"
                ) {
                    if (method.endsWith("requestApproval") && currentAccessMode == AccessMode.FULL_ACCESS) {
                        sendResponse(id, JsonPrimitive("accept"))
                    } else {
                        onApprovalRequest(id, method, params)
                    }
                } else {
                    sendErrorResponse(id, -32601, "Unsupported request method: $method")
                }
            } else {
                onNotification(method, params)
            }
            return
        }

        if (id != null && id !is JsonNull) {
            pendingResponses.remove(responseKey(id))?.complete(message)
        }
    }

    private suspend fun sendRpcMessage(message: JsonObject) {
        val text = message.toString()
        val session = sessionMutex.withLock { secureSession }
        val outboundText = if (session != null) {
            val payload = JsonObject(
                mapOf(
                    "bridgeOutboundSeq" to JsonNull,
                    "payloadText" to JsonPrimitive(text),
                ),
            )
            val securePayload = payload.toString().toByteArray()
            val nonce = SecureCrypto.secureNonce("iphone", session.nextOutboundCounter)
            val (ciphertext, tag) = SecureCrypto.encryptAesGcm(
                key = session.phoneToMacKey,
                nonce = nonce,
                plaintext = securePayload,
            )
            val envelope = JsonObject(
                mapOf(
                    "kind" to JsonPrimitive("encryptedEnvelope"),
                    "v" to JsonPrimitive(SECURE_PROTOCOL_VERSION),
                    "sessionId" to JsonPrimitive(session.sessionId),
                    "keyEpoch" to JsonPrimitive(session.keyEpoch),
                    "sender" to JsonPrimitive("iphone"),
                    "counter" to JsonPrimitive(session.nextOutboundCounter),
                    "ciphertext" to JsonPrimitive(ciphertext),
                    "tag" to JsonPrimitive(tag),
                ),
            )
            sessionMutex.withLock {
                secureSession = session.copy(nextOutboundCounter = session.nextOutboundCounter + 1)
            }
            envelope.toString()
        } else {
            text
        }
        val sent = socket?.send(outboundText) == true
        if (!sent) {
            throw IllegalStateException("Unable to send message to CodeRover bridge.")
        }
    }

    private suspend fun sendRawControl(message: JsonObject) {
        val sent = socket?.send(message.toString()) == true
        if (!sent) {
            throw IllegalStateException("Unable to send secure control message.")
        }
    }

    private fun scheduleBridgeReplayAck(bridgeOutboundSeq: Int) {
        if (bridgeOutboundSeq <= lastSentBridgeAckSeq) {
            return
        }
        pendingBridgeAckSeq = maxOf(pendingBridgeAckSeq ?: 0, bridgeOutboundSeq)
        if (bridgeAckFlushJob?.isActive == true) {
            return
        }
        bridgeAckFlushJob = scope.launch {
            delay(150)
            flushPendingBridgeReplayAck()
        }
    }

    private suspend fun flushPendingBridgeReplayAck() {
        val session = sessionMutex.withLock { secureSession }
        val ackSeq = pendingBridgeAckSeq
        if (session == null || ackSeq == null || ackSeq <= lastSentBridgeAckSeq) {
            bridgeAckFlushJob = null
            return
        }
        try {
            sendRawControl(
                JsonObject(
                    mapOf(
                        "kind" to JsonPrimitive("ackState"),
                        "sessionId" to JsonPrimitive(session.sessionId),
                        "keyEpoch" to JsonPrimitive(session.keyEpoch),
                        "lastAppliedBridgeOutboundSeq" to JsonPrimitive(ackSeq),
                    ),
                ),
            )
            lastSentBridgeAckSeq = ackSeq
            if (pendingBridgeAckSeq == ackSeq) {
                pendingBridgeAckSeq = null
            }
        } catch (error: Throwable) {
            Log.d(TAG, "ackState send failed", error)
        } finally {
            bridgeAckFlushJob = null
        }
    }

    private suspend fun failPending(error: Throwable) {
        pendingResponses.values.forEach { deferred ->
            if (!deferred.isCompleted) {
                deferred.completeExceptionally(error)
            }
        }
        pendingResponses.clear()
    }

    data class ConnectedSession(
        val macIdentityPublicKey: String,
        val fingerprint: String,
    )

    private data class SecureSession(
        val sessionId: String,
        val keyEpoch: Int,
        val macDeviceId: String,
        val macIdentityPublicKey: String,
        val phoneToMacKey: ByteArray,
        val macToPhoneKey: ByteArray,
        var lastInboundBridgeOutboundSeq: Int,
        var lastInboundCounter: Int,
        val nextOutboundCounter: Int,
    )
}
