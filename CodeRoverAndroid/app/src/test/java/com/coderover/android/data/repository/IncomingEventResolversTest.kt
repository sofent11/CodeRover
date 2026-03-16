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
    fun resolveTimelineItemIdPrefersCanonicalKeys() {
        val payload = JsonObject(
            mapOf(
                "timelineItemId" to JsonPrimitive("timeline-item-1"),
                "event" to JsonObject(
                    mapOf(
                        "item" to JsonObject(
                            mapOf(
                                "timeline_item_id" to JsonPrimitive("timeline-item-2"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals("timeline-item-1", payload.resolveTimelineItemId())
        assertEquals("timeline-item-1", payload.resolveItemId())
    }

    @Test
    fun resolvePreviousItemIdReadsEnvelopeAndNestedItemShapes() {
        val payload = JsonObject(
            mapOf(
                "msg" to JsonObject(
                    mapOf(
                        "item" to JsonObject(
                            mapOf(
                                "previous_item_id" to JsonPrimitive("item-8"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals("item-8", payload.resolvePreviousItemId())
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
