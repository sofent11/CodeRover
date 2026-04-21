package com.coderover.android.ui

import com.coderover.android.data.model.AccessMode
import com.coderover.android.data.model.AppFontStyle
import com.coderover.android.data.model.AppState
import com.coderover.android.data.model.PhoneIdentityState
import com.coderover.android.data.model.ThreadSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CodeRoverAppShellHeaderTest {
    @Test
    fun threadHeaderUsesProviderAndWorkingDirectoryContext() {
        val state = appState(
            threads = listOf(
                ThreadSummary(
                    id = "thread-1",
                    title = "Fix Android parity",
                    cwd = "/tmp/coderover/android",
                    provider = "claude",
                ),
            ),
            selectedThreadId = "thread-1",
        )

        val header = shellHeader(AppShellContent.THREAD, state)

        assertEquals("Fix Android parity", header.title)
        assertEquals("Claude", header.providerTitle)
        assertEquals("/tmp/coderover/android", header.pathSubtitle)
        assertEquals("/tmp/coderover/android", header.fullPath)
    }

    @Test
    fun emptyHeaderKeepsGenericSubtitle() {
        val header = shellHeader(AppShellContent.EMPTY, appState())

        assertEquals("CodeRover", header.title)
        assertEquals("Your paired Mac", header.subtitle)
        assertNull(header.providerTitle)
        assertNull(header.pathSubtitle)
    }

    private fun appState(
        threads: List<ThreadSummary> = emptyList(),
        selectedThreadId: String? = null,
    ): AppState {
        return AppState(
            onboardingSeen = true,
            fontStyle = AppFontStyle.SYSTEM,
            accessMode = AccessMode.ON_REQUEST,
            phoneIdentityState = PhoneIdentityState(
                phoneDeviceId = "phone-1",
                phoneIdentityPrivateKey = "private",
                phoneIdentityPublicKey = "public",
            ),
            threads = threads,
            selectedThreadId = selectedThreadId,
        )
    }
}
