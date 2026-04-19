// FILE: BridgeStatusModels.swift
// Purpose: Client-side bridge status and update prompt models for local settings surfaces.

import Foundation

struct CodeRoverBridgeVersionSupport: Equatable, Sendable {
    var minimumVersion: String?
    var maximumVersion: String?
    var recommendedVersion: String?

    init(json: [String: JSONValue]) {
        self.minimumVersion = json["minimumVersion"]?.stringValue
        self.maximumVersion = json["maximumVersion"]?.stringValue
        self.recommendedVersion = json["recommendedVersion"]?.stringValue
    }

    var displayLabel: String {
        if let minimumVersion, let maximumVersion {
            return "\(minimumVersion) - \(maximumVersion)"
        }
        if let minimumVersion {
            return "\(minimumVersion)+"
        }
        if let recommendedVersion {
            return recommendedVersion
        }
        return "Unknown"
    }
}

struct CodeRoverBridgeMobileSupportMatrix: Equatable, Sendable {
    var ios: CodeRoverBridgeVersionSupport?
    var android: CodeRoverBridgeVersionSupport?

    init(json: [String: JSONValue]) {
        self.ios = json["ios"]?.objectValue.map(CodeRoverBridgeVersionSupport.init(json:))
        self.android = json["android"]?.objectValue.map(CodeRoverBridgeVersionSupport.init(json:))
    }
}

struct CodeRoverBridgeStatus: Equatable, Sendable {
    var bridgeVersion: String?
    var bridgeLatestVersion: String?
    var updateAvailable: Bool
    var upgradeCommand: String?
    var keepAwakeEnabled: Bool
    var keepAwakeActive: Bool
    var trustedDeviceCount: Int
    var trustedDeviceStatus: String?
    var supportedMobileVersions: CodeRoverBridgeMobileSupportMatrix?

    init(json: [String: JSONValue]) {
        self.bridgeVersion = json["bridgeVersion"]?.stringValue
        self.bridgeLatestVersion = json["bridgeLatestVersion"]?.stringValue
        self.updateAvailable = json["updateAvailable"]?.boolValue ?? false
        self.upgradeCommand = json["upgradeCommand"]?.stringValue
        self.keepAwakeEnabled = (
            json["keepAwakeEnabled"]?.boolValue
            ?? json["preferences"]?.objectValue?["keepAwakeEnabled"]?.boolValue
            ?? false
        )
        self.keepAwakeActive = json["keepAwakeActive"]?.boolValue ?? false
        self.trustedDeviceCount = json["trustedDeviceCount"]?.intValue ?? 0
        self.trustedDeviceStatus = json["trustedDeviceStatus"]?.stringValue
        self.supportedMobileVersions = json["supportedMobileVersions"]?.objectValue.map(
            CodeRoverBridgeMobileSupportMatrix.init(json:)
        )
    }

    var bridgeVersionLabel: String {
        bridgeVersion ?? "Unavailable"
    }

    var latestVersionLabel: String {
        bridgeLatestVersion ?? "Unavailable"
    }
}

struct CodeRoverBridgeUpdatePrompt: Equatable, Sendable, Identifiable {
    var shouldPrompt: Bool
    var kind: String
    var title: String?
    var message: String?
    var bridgeVersion: String?
    var bridgeLatestVersion: String?
    var upgradeCommand: String?

    init(json: [String: JSONValue]) {
        self.shouldPrompt = json["shouldPrompt"]?.boolValue ?? false
        self.kind = json["kind"]?.stringValue ?? "none"
        self.title = json["title"]?.stringValue
        self.message = json["message"]?.stringValue
        self.bridgeVersion = json["bridgeVersion"]?.stringValue
        self.bridgeLatestVersion = json["bridgeLatestVersion"]?.stringValue
        self.upgradeCommand = json["upgradeCommand"]?.stringValue
    }

    var id: String {
        [
            kind,
            bridgeVersion ?? "bridge",
            bridgeLatestVersion ?? "latest",
        ].joined(separator: ":")
    }
}
