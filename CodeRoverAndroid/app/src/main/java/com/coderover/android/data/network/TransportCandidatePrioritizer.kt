package com.coderover.android.data.network

import com.coderover.android.data.model.PairingRecord
import com.coderover.android.data.model.TransportCandidate
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

internal object TransportCandidatePrioritizer {
    fun orderedTransportUrls(
        pairingRecord: PairingRecord,
        localIpv4Addresses: Set<String> = currentLocalIpv4Addresses(),
    ): List<String> {
        return orderedTransportCandidates(
            candidates = pairingRecord.transportCandidates,
            preferredTransportUrl = pairingRecord.preferredTransportUrl,
            lastSuccessfulTransportUrl = pairingRecord.lastSuccessfulTransportUrl,
            localIpv4Addresses = localIpv4Addresses,
        ).map(TransportCandidate::url)
    }

    fun orderedTransportCandidates(
        candidates: List<TransportCandidate>,
        preferredTransportUrl: String? = null,
        lastSuccessfulTransportUrl: String? = null,
        localIpv4Addresses: Set<String> = currentLocalIpv4Addresses(),
    ): List<TransportCandidate> {
        val preferred = preferredTransportUrl?.trim().orEmpty().ifEmpty { null }
        val lastSuccessful = lastSuccessfulTransportUrl?.trim().orEmpty().ifEmpty { null }
        return candidates
            .mapIndexedNotNull { index, candidate ->
                if (candidate.isUsableReconnectCandidate()) {
                    IndexedCandidate(index, candidate)
                } else {
                    null
                }
            }
            .sortedWith(
                compareBy<IndexedCandidate> {
                    it.candidate.reconnectNetworkPriority(localIpv4Addresses)
                }.thenBy {
                    when (it.candidate.url) {
                        preferred -> 0
                        lastSuccessful -> 1
                        else -> 2
                    }
                }.thenBy {
                    it.candidate.reconnectKindPriority()
                }.thenBy {
                    it.index
                },
            )
            .map(IndexedCandidate::candidate)
    }

    private fun currentLocalIpv4Addresses(): Set<String> {
        return runCatching {
            NetworkInterface.getNetworkInterfaces()
                ?.let(Collections::list)
                .orEmpty()
                .asSequence()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { Collections.list(it.inetAddresses).asSequence() }
                .filterIsInstance<Inet4Address>()
                .map { it.hostAddress.orEmpty() }
                .mapNotNull(String::normalizedIpv4Address)
                .filterNot { it.startsWith("127.") || it.startsWith("169.254.") }
                .toSet()
        }.getOrDefault(emptySet())
    }

    private data class IndexedCandidate(
        val index: Int,
        val candidate: TransportCandidate,
    )
}

private fun TransportCandidate.isUsableReconnectCandidate(): Boolean {
    val host = transportHost() ?: return false
    if (kind == "local_ipv4" && host.startsWith("169.254.")) {
        return false
    }
    return true
}

private fun TransportCandidate.reconnectNetworkPriority(localIpv4Addresses: Set<String>): Int {
    val host = transportHost().orEmpty()
    val ipv4 = host.normalizedIpv4Address()
    if (ipv4 != null) {
        if (localIpv4Addresses.any { it.isSameIpv4Subnet(ipv4) }) {
            return 0
        }
        if (ipv4.isPublicIpv4Address()) {
            return 1
        }
        return 4
    }

    if (kind == "tailnet_ipv4" || kind == "tailnet" || host.endsWith(".ts.net")) {
        return 2
    }

    if (kind == "local_hostname" || host.endsWith(".local")) {
        return 3
    }

    return 1
}

private fun TransportCandidate.reconnectKindPriority(): Int {
    return when (kind) {
        "local_ipv4" -> 0
        "tailnet_ipv4", "tailnet" -> 1
        "local_hostname" -> 2
        else -> 3
    }
}

private fun TransportCandidate.transportHost(): String? {
    val urlText = url.trim()
    return runCatching {
        java.net.URI(urlText).host?.trim()?.takeIf(String::isNotEmpty)
    }.getOrNull()
}

private fun String.normalizedIpv4Address(): String? {
    val octets = split(".")
    if (octets.size != 4) {
        return null
    }
    val normalized = octets.map { it.toIntOrNull() ?: return null }
    if (normalized.any { it !in 0..255 }) {
        return null
    }
    return normalized.joinToString(".")
}

private fun String.isSameIpv4Subnet(other: String): Boolean {
    val lhs = normalizedIpv4Address()?.split(".") ?: return false
    val rhs = other.normalizedIpv4Address()?.split(".") ?: return false
    return lhs[0] == rhs[0] && lhs[1] == rhs[1] && lhs[2] == rhs[2]
}

private fun String.isPublicIpv4Address(): Boolean {
    val octets = normalizedIpv4Address()?.split(".")?.mapNotNull(String::toIntOrNull) ?: return false
    val first = octets[0]
    val second = octets[1]
    if (first == 10 || first == 127 || first == 0) {
        return false
    }
    if (first == 169 && second == 254) {
        return false
    }
    if (first == 172 && second in 16..31) {
        return false
    }
    if (first == 192 && second == 168) {
        return false
    }
    if (first >= 224) {
        return false
    }
    return true
}
