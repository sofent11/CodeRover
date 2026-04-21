package com.coderover.android.data.model

import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadTimelineStateTest {
    @Test
    fun upsertAndReadRemainStableDuringConcurrentRealtimeUpdates() {
        val timelineState = ThreadTimelineState()
        val workerCount = 6
        val messagesPerWorker = 120
        val startLatch = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(workerCount)

        val futures = (0 until workerCount).map { workerIndex ->
            executor.submit(Callable {
                startLatch.await(5, TimeUnit.SECONDS)
                repeat(messagesPerWorker) { messageIndex ->
                    timelineState.upsert(
                        ChatMessage(
                            id = "message-$workerIndex-$messageIndex",
                            threadId = "thread-1",
                            role = MessageRole.SYSTEM,
                            kind = MessageKind.CHAT,
                            text = "message-$workerIndex-$messageIndex",
                            orderIndex = workerIndex * messagesPerWorker + messageIndex,
                        ),
                    )
                    timelineState.renderedMessages()
                }
            })
        }

        startLatch.countDown()
        futures.forEach { it.get(10, TimeUnit.SECONDS) }
        executor.shutdownNow()

        assertEquals(workerCount * messagesPerWorker, timelineState.renderedMessages().size)
    }
}
