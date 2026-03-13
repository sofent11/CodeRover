// FILE: SecureStore.swift
// Purpose: Small Keychain wrapper for sensitive app settings.
// Layer: Service
// Exports: SecureStore, CodeRoverSecureKeys
// Depends on: Security

import Foundation
import Security

enum CodeRoverSecureKeys {
    static let pairingRecords = "coderover.pairing.records"
    static let pairingActiveMacDeviceId = "coderover.pairing.activeMacDeviceId"
    static let pairingBridgeId = "coderover.pairing.bridgeId"
    static let pairingTransportCandidates = "coderover.pairing.transportCandidates"
    static let pairingPreferredTransportURL = "coderover.pairing.preferredTransportURL"
    static let pairingLastSuccessfulTransportURL = "coderover.pairing.lastSuccessfulTransportURL"
    static let pairingMacDeviceId = "coderover.pairing.macDeviceId"
    static let pairingMacIdentityPublicKey = "coderover.pairing.macIdentityPublicKey"
    static let secureProtocolVersion = "coderover.secure.protocolVersion"
    static let secureLastAppliedBridgeOutboundSeq = "coderover.secure.lastAppliedBridgeOutboundSeq"
    static let trustedMacRegistry = "coderover.secure.trustedMacRegistry"
    static let phoneIdentityState = "coderover.secure.phoneIdentityState"
    static let messageHistoryKey = "coderover.local.messageHistoryKey"
}

enum SecureStore {
    // Reads a UTF-8 string value from Keychain.
    static func readString(for key: String) -> String? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let stringValue = String(data: data, encoding: .utf8) else {
            return nil
        }

        return stringValue
    }

    // Reads opaque key material or encrypted payload blobs from Keychain.
    static func readData(for key: String) -> Data? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data else {
            return nil
        }

        return data
    }

    // Writes a UTF-8 string to Keychain; empty values are treated as delete.
    static func writeString(_ value: String, for key: String) {
        if value.isEmpty {
            deleteValue(for: key)
            return
        }

        writeData(Data(value.utf8), for: key)
    }

    // Stores raw data in Keychain; used by local message-history encryption keys.
    static func writeData(_ value: Data, for key: String) {
        if value.isEmpty {
            deleteValue(for: key)
            return
        }

        deleteValue(for: key)

        var query = baseQuery(for: key)
        query[kSecValueData as String] = value

        SecItemAdd(query as CFDictionary, nil)
    }

    // Convenience wrapper for small Codable payloads kept in Keychain.
    static func readCodable<Value: Decodable>(_ type: Value.Type, for key: String) -> Value? {
        guard let data = readData(for: key) else {
            return nil
        }
        return try? JSONDecoder().decode(type, from: data)
    }

    // Convenience wrapper for small Codable payloads kept in Keychain.
    static func writeCodable<Value: Encodable>(_ value: Value, for key: String) {
        guard let data = try? JSONEncoder().encode(value) else {
            return
        }
        writeData(data, for: key)
    }

    static func deleteValue(for key: String) {
        let query = baseQuery(for: key)
        SecItemDelete(query as CFDictionary)
    }

    private static func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
        ]
    }

    private static var serviceName: String {
        Bundle.main.bundleIdentifier ?? "com.sofent.CodeRover"
    }
}
