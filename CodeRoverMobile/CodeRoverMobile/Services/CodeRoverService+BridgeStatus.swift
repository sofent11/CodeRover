// FILE: CodeRoverService+BridgeStatus.swift
// Purpose: Fetches bridge compatibility metadata and updates local bridge preferences.

import Foundation

extension CodeRoverService {
    func refreshBridgeMetadata() async {
        guard isConnected else {
            bridgeStatus = nil
            bridgeUpdatePrompt = nil
            isLoadingBridgeStatus = false
            return
        }

        isLoadingBridgeStatus = true
        defer { isLoadingBridgeStatus = false }

        do {
            let statusResponse = try await sendRequest(
                method: "bridge/status/read",
                params: .object([:])
            )
            if let resultObject = statusResponse.result?.objectValue {
                bridgeStatus = CodeRoverBridgeStatus(json: resultObject)
            }
        } catch {
            bridgeStatus = nil
        }

        do {
            let promptResponse = try await sendRequest(
                method: "bridge/updatePrompt/read",
                params: .object([:])
            )
            if let resultObject = promptResponse.result?.objectValue {
                bridgeUpdatePrompt = CodeRoverBridgeUpdatePrompt(json: resultObject)
            }
        } catch {
            bridgeUpdatePrompt = nil
        }
    }

    func setBridgeKeepAwakeEnabled(_ enabled: Bool) async {
        let previousStatus = bridgeStatus
        if bridgeStatus != nil {
            bridgeStatus?.keepAwakeEnabled = enabled
            bridgeStatus?.keepAwakeActive = enabled
        }

        do {
            let response = try await sendRequest(
                method: "bridge/preferences/update",
                params: .object([
                    "keepAwakeEnabled": .bool(enabled),
                ])
            )

            if let resultObject = response.result?.objectValue {
                if bridgeStatus == nil {
                    bridgeStatus = CodeRoverBridgeStatus(json: resultObject)
                } else {
                    bridgeStatus?.keepAwakeEnabled = (
                        resultObject["keepAwakeEnabled"]?.boolValue
                        ?? resultObject["preferences"]?.objectValue?["keepAwakeEnabled"]?.boolValue
                        ?? enabled
                    )
                    bridgeStatus?.keepAwakeActive = resultObject["keepAwakeActive"]?.boolValue ?? enabled
                }
            }
        } catch {
            bridgeStatus = previousStatus
        }
    }
}
