package com.coderover.android.data.repository

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IncomingEventResolversTest {
    @Test
    fun resolveThreadIdAcceptsConversationIdShapes() {
        val payload = JsonObject(
            mapOf(
                "conversationId" to JsonPrimitive("thread-conversation"),
            ),
        )

        assertEquals("thread-conversation", payload.resolveThreadId())
    }

    @Test
    fun resolveThreadIdFallsBackToEnvelopeEventPayload() {
        val payload = JsonObject(
            mapOf(
                "msg" to JsonObject(
                    mapOf(
                        "conversation_id" to JsonPrimitive("thread-envelope"),
                    ),
                ),
            ),
        )

        assertEquals("thread-envelope", payload.resolveThreadId())
    }

    @Test
    fun resolveTurnAndItemIdsReadNestedEventShapes() {
        val payload = JsonObject(
            mapOf(
                "event" to JsonObject(
                    mapOf(
                        "turn_id" to JsonPrimitive("turn-42"),
                        "item" to JsonObject(
                            mapOf(
                                "id" to JsonPrimitive("item-9"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals("turn-42", payload.resolveTurnId())
        assertEquals("item-9", payload.resolveItemId())
    }

    @Test
    fun resolveThreadIdReturnsNullWhenNoSupportedShapeExists() {
        val payload = JsonObject(
            mapOf(
                "status" to JsonPrimitive("running"),
            ),
        )

        assertNull(payload.resolveThreadId())
    }
}
