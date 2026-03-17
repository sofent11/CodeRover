// FILE: MessagePersistence.swift
// Purpose: Persists per-thread message timelines to disk between app launches.
// Layer: Service
// Exports: MessagePersistence
// Depends on: Foundation, CryptoKit, ChatMessage

import CryptoKit
import Foundation

struct PersistedConversationCache: Codable {
    var messagesByThread: [String: [ChatMessage]]
}

private struct LegacyPersistedConversationCache: Codable {
    var messagesByThread: [String: [ChatMessage]]
    var historyStateByThread: [String: LegacyIgnoredHistoryState]?
}

private struct LegacyIgnoredHistoryState: Codable {
}

struct MessagePersistence {
    // v7 encrypts the on-device message cache while keeping backward-compatible legacy fallbacks.
    private let fileName = "coderover-message-history-v7.bin"
    private let legacyFileNames = [
        "coderover-message-history-v6.bin",
        "coderover-message-history-v5.json",
        "coderover-message-history-v4.json",
        "coderover-message-history-v3.json",
        "coderover-message-history-v2.json",
        "coderover-message-history.json",
    ]

    // Loads the saved message/cache envelope from disk. Returns an empty store on failure.
    func load() -> PersistedConversationCache {
        let decoder = JSONDecoder()

        for fileURL in storeURLs {
            guard let data = try? Data(contentsOf: fileURL) else {
                continue
            }

            if fileURL.pathExtension == "bin",
               let decrypted = decryptPersistedPayload(data) {
                if let envelope = try? decoder.decode(PersistedConversationCache.self, from: decrypted) {
                    return sanitizedForPersistence(envelope)
                }
                if let legacyEnvelope = try? decoder.decode(LegacyPersistedConversationCache.self, from: decrypted) {
                    return PersistedConversationCache(
                        messagesByThread: sanitizedForPersistence(legacyEnvelope.messagesByThread)
                    )
                }
                if let legacyMessages = try? decoder.decode([String: [ChatMessage]].self, from: decrypted) {
                    return PersistedConversationCache(
                        messagesByThread: sanitizedForPersistence(legacyMessages)
                    )
                }
            }

            if let envelope = try? decoder.decode(PersistedConversationCache.self, from: data) {
                return sanitizedForPersistence(envelope)
            }
            if let legacyEnvelope = try? decoder.decode(LegacyPersistedConversationCache.self, from: data) {
                return PersistedConversationCache(
                    messagesByThread: sanitizedForPersistence(legacyEnvelope.messagesByThread)
                )
            }

            if let legacyMessages = try? decoder.decode([String: [ChatMessage]].self, from: data) {
                return PersistedConversationCache(
                    messagesByThread: sanitizedForPersistence(legacyMessages)
                )
            }
        }

        return PersistedConversationCache(messagesByThread: [:])
    }

    // Persists all thread timelines atomically to avoid corrupt partial writes.
    func save(messagesByThread: [String: [ChatMessage]]) {
        let encoder = JSONEncoder()
        let envelope = PersistedConversationCache(
            messagesByThread: sanitizedForPersistence(messagesByThread)
        )
        guard let plaintext = try? encoder.encode(envelope),
              let data = encryptPersistedPayload(plaintext) else {
            return
        }

        let fileURL = storeURL
        ensureParentDirectoryExists(for: fileURL)
        try? data.write(to: fileURL, options: [.atomic])
    }

    private var storeURL: URL {
        storeURLs[0]
    }

    private var storeURLs: [URL] {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let bundleID = Bundle.main.bundleIdentifier ?? "com.sofent.CodeRover"
        let directory = base.appendingPathComponent(bundleID, isDirectory: true)
        let names = [fileName] + legacyFileNames
        return names.map { directory.appendingPathComponent($0, isDirectory: false) }
    }

    private func ensureParentDirectoryExists(for fileURL: URL) {
        let directory = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    // Uses a Keychain-backed AES key so chat history remains private if the app data is copied out.
    private func encryptPersistedPayload(_ plaintext: Data) -> Data? {
        let key = messageHistoryKey()
        let sealedBox = try? AES.GCM.seal(plaintext, using: key)
        return sealedBox?.combined
    }

    // Opens the encrypted chat cache while still allowing plaintext fallbacks from older app versions.
    private func decryptPersistedPayload(_ encryptedData: Data) -> Data? {
        let key = messageHistoryKey()
        guard let sealedBox = try? AES.GCM.SealedBox(combined: encryptedData) else {
            return nil
        }
        return try? AES.GCM.open(sealedBox, using: key)
    }

    private func messageHistoryKey() -> SymmetricKey {
        if let storedKey = SecureStore.readData(for: CodeRoverSecureKeys.messageHistoryKey) {
            return SymmetricKey(data: storedKey)
        }

        let newKey = SymmetricKey(size: .bits256)
        let keyData = newKey.withUnsafeBytes { Data($0) }
        SecureStore.writeData(keyData, for: CodeRoverSecureKeys.messageHistoryKey)
        return newKey
    }

    // Structured input cards are live request state, not durable history; dropping them
    // here prevents stale prompts from resurfacing after reconnects or relaunches.
    private func sanitizedForPersistence(_ value: [String: [ChatMessage]]) -> [String: [ChatMessage]] {
        value.mapValues { messages in
            messages.filter { $0.kind != .userInputPrompt }
        }
    }

    private func sanitizedForPersistence(_ cache: PersistedConversationCache) -> PersistedConversationCache {
        PersistedConversationCache(
            messagesByThread: sanitizedForPersistence(cache.messagesByThread)
        )
    }
}
