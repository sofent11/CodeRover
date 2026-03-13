// FILE: CodeRoverService+Transport.swift
// Purpose: Outbound JSON-RPC transport and pending-response coordination.
// Layer: Service
// Exports: CodeRoverService transport internals
// Depends on: Network.NWConnection

import Foundation
import Network

extension CodeRoverService {
    var requestTimeoutNanoseconds: UInt64 { 20_000_000_000 }

    // Sends an RPC request and waits for the matching response by request id.
    func sendRequest(method: String, params: JSONValue?) async throws -> RPCMessage {
        if let requestTransportOverride {
            return try await requestTransportOverride(method, params)
        }

        guard isConnected, webSocketConnection != nil else {
            throw CodeRoverServiceError.disconnected
        }

        let requestID: JSONValue = .string(UUID().uuidString)
        let requestKey = idKey(from: requestID)

        let request = RPCMessage(
            id: requestID,
            method: method,
            params: params,
            includeJSONRPC: false
        )
        let requestContext = pendingRequestContext(method: method, params: params)

        return try await withCheckedThrowingContinuation { continuation in
            pendingRequests[requestKey] = continuation
            pendingRequestContexts[requestKey] = requestContext
            pendingRequestTimeoutTasks[requestKey] = Task { @MainActor [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: requestTimeoutNanoseconds)
                guard !Task.isCancelled else { return }

                guard let pendingContinuation = pendingRequests.removeValue(forKey: requestKey) else {
                    pendingRequestTimeoutTasks.removeValue(forKey: requestKey)
                    pendingRequestContexts.removeValue(forKey: requestKey)
                    return
                }

                pendingRequestTimeoutTasks.removeValue(forKey: requestKey)
                pendingRequestContexts.removeValue(forKey: requestKey)
                pendingContinuation.resume(
                    throwing: CodeRoverServiceError.invalidInput(
                        "The Mac bridge did not respond in time. Reconnect and try again."
                    )
                )
            }

            Task {
                do {
                    try await sendMessage(request)
                } catch {
                    pendingRequestTimeoutTasks.removeValue(forKey: requestKey)?.cancel()
                    pendingRequestContexts.removeValue(forKey: requestKey)
                    // Avoid double-resume if the request was already completed
                    // (for example by a disconnect race that fails all pending requests).
                    if let pendingContinuation = pendingRequests.removeValue(forKey: requestKey) {
                        pendingContinuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    // Sends a fire-and-forget RPC notification.
    func sendNotification(method: String, params: JSONValue?) async throws {
        let notification = RPCMessage(
            jsonrpc: nil,
            id: nil,
            method: method,
            params: params,
            result: nil,
            error: nil
        )

        try await sendMessage(notification)
    }

    // Sends an RPC response for a server-initiated request.
    func sendResponse(id: JSONValue, result: JSONValue) async throws {
        let response = RPCMessage(id: id, result: result, includeJSONRPC: false)
        try await sendMessage(response)
    }

    // Sends an RPC error response for unsupported or invalid server requests.
    func sendErrorResponse(id: JSONValue?, code: Int, message: String, data: JSONValue? = nil) async throws {
        let rpcError = RPCError(code: code, message: message, data: data)
        let response = RPCMessage(id: id, error: rpcError, includeJSONRPC: false)
        try await sendMessage(response)
    }

    func sendMessage(_ message: RPCMessage) async throws {
        let payload = try encoder.encode(message)
        guard let plaintext = String(data: payload, encoding: .utf8) else {
            throw CodeRoverServiceError.invalidResponse("Unable to encode outgoing JSON-RPC payload")
        }

        let secureText = try secureWireText(for: plaintext)
        try await sendRawText(secureText)
    }

    // Sends raw secure control messages before the JSON-RPC channel is initialized.
    func sendRawText(_ text: String) async throws {
        guard let connection = webSocketConnection else {
            throw CodeRoverServiceError.disconnected
        }

        let payload = Data(text.utf8)
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "coderover-jsonrpc", metadata: [metadata])

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(
                content: payload,
                contentContext: context,
                isComplete: true,
                completion: .contentProcessed { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: ())
                    }
                }
            )
        }
    }

    func startReceiveLoop(with connection: NWConnection) {
        receiveNextMessage(on: connection)
    }

    func receiveNextMessage(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }

            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.webSocketConnection === connection else { return }

                if let error {
                    self.handleReceiveError(error)
                    return
                }

                if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata,
                   metadata.opcode == .close {
                    self.handleReceiveError(CodeRoverServiceError.disconnected)
                    return
                }

                if let data,
                   let text = String(data: data, encoding: .utf8) {
                    self.lastRawMessage = text
                    self.processIncomingWireText(text)
                }

                self.receiveNextMessage(on: connection)
            }
        }
    }

    func establishWebSocketConnection(url: URL, token: String, role: String? = nil) async throws -> NWConnection {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss" else {
            throw CodeRoverServiceError.invalidServerURL(url.absoluteString)
        }

        let webSocketOptions = NWProtocolWebSocket.Options()
        webSocketOptions.autoReplyPing = true

        if let role, !role.isEmpty {
            webSocketOptions.setAdditionalHeaders([
                (name: "x-role", value: role)
            ])
        } else if !token.isEmpty {
            webSocketOptions.setAdditionalHeaders([
                (name: "Authorization", value: "Bearer \(token)")
            ])
        }

        let tlsOptions: NWProtocolTLS.Options? = (scheme == "wss") ? NWProtocolTLS.Options() : nil
        let parameters = NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options())
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocketOptions, at: 0)

        let connection = NWConnection(to: .url(url), using: parameters)
        let connectionTimeoutNanoseconds: UInt64 = 12_000_000_000

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let lock = NSLock()
            var didFinish = false
            var timeoutTask: Task<Void, Never>?

            func finish(_ result: Result<Void, Error>) {
                lock.lock()
                defer { lock.unlock() }
                guard !didFinish else { return }
                didFinish = true
                timeoutTask?.cancel()
                continuation.resume(with: result)
                // Ignore future state transitions after first completion.
                connection.stateUpdateHandler = { _ in }
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(.success(()))
                case .failed(let error):
                    finish(.failure(error))
                case .cancelled:
                    finish(.failure(CodeRoverServiceError.disconnected))
                default:
                    break
                }
            }

            connection.start(queue: webSocketQueue)

            timeoutTask = Task { [weak connection] in
                try? await Task.sleep(nanoseconds: connectionTimeoutNanoseconds)
                guard !Task.isCancelled else { return }
                connection?.cancel()
                finish(.failure(CodeRoverServiceError.invalidInput("Connection timed out after 12s")))
            }
        }

        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.webSocketConnection === connection else { return }

                switch state {
                case .failed(let error):
                    self.handleReceiveError(error)
                case .cancelled:
                    if self.isConnected {
                        self.handleReceiveError(CodeRoverServiceError.disconnected)
                    }
                default:
                    break
                }
            }
        }

        return connection
    }

    func failAllPendingRequests(with error: Error) {
        let timeoutTasks = pendingRequestTimeoutTasks
        pendingRequestTimeoutTasks.removeAll()
        pendingRequestContexts.removeAll()
        let continuations = pendingRequests
        pendingRequests.removeAll()

        for timeoutTask in timeoutTasks.values {
            timeoutTask.cancel()
        }
        for continuation in continuations.values {
            continuation.resume(throwing: error)
        }
    }

    func pendingRequestContext(method: String, params: JSONValue?) -> CodeRoverPendingRequestContext {
        let paramsObject = params?.objectValue
        let threadId = paramsObject?["threadId"]?.stringValue
            ?? paramsObject?["thread_id"]?.stringValue

        return CodeRoverPendingRequestContext(
            method: method,
            threadId: threadId,
            createdAt: Date()
        )
    }

    func completePendingTurnStartIfNeeded(threadId: String, turnId: String?) {
        let matchingEntry = pendingRequestContexts
            .filter { _, context in
                context.method == "turn/start" && context.threadId == threadId
            }
            .min { lhs, rhs in
                lhs.value.createdAt < rhs.value.createdAt
            }

        guard let requestKey = matchingEntry?.key,
              let continuation = pendingRequests.removeValue(forKey: requestKey) else {
            if lastErrorMessage == "The Mac bridge did not respond in time. Reconnect and try again." {
                lastErrorMessage = nil
            }
            return
        }

        pendingRequestTimeoutTasks.removeValue(forKey: requestKey)?.cancel()
        pendingRequestContexts.removeValue(forKey: requestKey)

        var result: RPCObject = ["threadId": .string(threadId)]
        if let turnId,
           !turnId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result["turnId"] = .string(turnId)
        }

        continuation.resume(
            returning: RPCMessage(
                id: responseID(from: requestKey),
                result: .object(result),
                includeJSONRPC: false
            )
        )
        if lastErrorMessage == "The Mac bridge did not respond in time. Reconnect and try again." {
            lastErrorMessage = nil
        }
    }

    func idKey(from id: JSONValue) -> String {
        switch id {
        case .string(let value):
            return "s:\(value)"
        case .integer(let value):
            return "i:\(value)"
        case .double(let value):
            return "d:\(value)"
        case .bool(let value):
            return "b:\(value)"
        case .null:
            return "null"
        case .object, .array:
            return "complex:\(String(describing: id))"
        }
    }

    func responseID(from requestKey: String) -> JSONValue {
        if requestKey.hasPrefix("s:") {
            return .string(String(requestKey.dropFirst(2)))
        }
        if requestKey.hasPrefix("i:"), let value = Int(String(requestKey.dropFirst(2))) {
            return .integer(value)
        }
        if requestKey.hasPrefix("d:"), let value = Double(String(requestKey.dropFirst(2))) {
            return .double(value)
        }
        if requestKey.hasPrefix("b:") {
            return .bool(String(requestKey.dropFirst(2)) == "true")
        }
        return .string(requestKey)
    }
}
