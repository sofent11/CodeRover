package com.coderover.android.data.network

import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.TransportCandidate
import org.junit.Assert.assertEquals
import org.junit.Test

class TransportCandidatePrioritizerTest {
    @Test
    fun sameSubnetCandidateBeatsPublicAndOtherPrivateAddresses() {
        val pairing = PairingRecord(
            bridgeId = "bridge-1",
            macDeviceId = "mac-1",
            macIdentityPublicKey = "pub",
            transportCandidates = listOf(
                TransportCandidate(kind = "local_ipv4", url = "ws://10.0.0.8:8765/bridge/test"),
                TransportCandidate(kind = "relay", url = "ws://8.8.8.8:8765/bridge/test"),
                TransportCandidate(kind = "local_ipv4", url = "ws://192.168.1.40:8765/bridge/test"),
            ),
        )

        val ordered = TransportCandidatePrioritizer.orderedTransportUrls(
            pairingRecord = pairing,
            localIpv4Addresses = setOf("192.168.1.23"),
        )

        assertEquals(
            listOf(
                "ws://192.168.1.40:8765/bridge/test",
                "ws://8.8.8.8:8765/bridge/test",
                "ws://10.0.0.8:8765/bridge/test",
            ),
            ordered,
        )
    }

    @Test
    fun publicIpBeatsMismatchedPrivateIpEvenWhenPrivateWasPreferred() {
        val pairing = PairingRecord(
            bridgeId = "bridge-1",
            macDeviceId = "mac-1",
            macIdentityPublicKey = "pub",
            transportCandidates = listOf(
                TransportCandidate(kind = "local_ipv4", url = "ws://192.168.0.10:8765/bridge/test"),
                TransportCandidate(kind = "relay", url = "ws://1.2.3.4:8765/bridge/test"),
            ),
            preferredTransportUrl = "ws://192.168.0.10:8765/bridge/test",
        )

        val ordered = TransportCandidatePrioritizer.orderedTransportUrls(
            pairingRecord = pairing,
            localIpv4Addresses = setOf("172.20.10.5"),
        )

        assertEquals(
            listOf(
                "ws://1.2.3.4:8765/bridge/test",
                "ws://192.168.0.10:8765/bridge/test",
            ),
            ordered,
        )
    }
}
