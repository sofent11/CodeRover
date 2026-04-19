// FILE: TurnMessageCaches.swift
// Purpose: Thread-safe caches for parsed markdown, file-change state, command status, diff chunks,
//   code comment directives, and file-change grouping.
// Layer: View Support
// Exports: MarkdownRenderableTextCache, MessageRowMarkdownSegmentCache, FileChangeRenderState,
//   CommandExecutionStatusCache, FileChangeSystemRenderCache, PerFileDiffChunk, PerFileDiffParser,
//   PerFileDiffChunkCache, CodeCommentDirectiveContentCache, FileChangeGroupingCache
// Depends on: Foundation, TurnMessageRegexCache, TurnFileChangeSummaryParser, TurnDiffLineKind, MarkdownRenderProfile, MarkdownSegment

import Foundation

enum MarkdownRenderableTextCache {
    static let maxEntries = 512
    static let lock = NSLock()
    static var renderedByKey: [String: String] = [:]

    // Caches markdown-to-renderable transformation to reduce repeated line/regex work.
    static func rendered(
        raw: String,
        profile: MarkdownRenderProfile,
        builder: () -> String
    ) -> String {
        let cacheKey = "\(profile.cacheKey)|\(raw.hashValue)"

        lock.lock()
        if let cached = renderedByKey[cacheKey] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let rendered = builder()

        lock.lock()
        if renderedByKey.count >= maxEntries {
            renderedByKey.removeAll(keepingCapacity: true)
        }
        renderedByKey[cacheKey] = rendered
        lock.unlock()

        return rendered
    }
}

enum MessageRowMarkdownSegmentCache {
    static let maxEntries = 512
    static let lock = NSLock()
    static var segmentsByKey: [String: [MarkdownSegment]] = [:]

    // Reuses parsed segments during stream updates to avoid repeated regex work.
    static func segments(messageID: String, text: String) -> [MarkdownSegment] {
        let cacheKey = "\(messageID)|\(text.hashValue)"

        lock.lock()
        if let cached = segmentsByKey[cacheKey] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let parsed = parseMarkdownSegments(text)

        lock.lock()
        if segmentsByKey.count >= maxEntries {
            segmentsByKey.removeAll(keepingCapacity: true)
        }
        segmentsByKey[cacheKey] = parsed
        lock.unlock()

        return parsed
    }
}

struct FileChangeRenderState {
    let summary: TurnFileChangeSummary?
    let actionEntries: [TurnFileChangeSummaryEntry]
    let bodyText: String
}

enum CommandExecutionStatusCache {
    static let maxEntries = 256
    static let lock = NSLock()
    static var statusByKey: [String: CommandExecutionStatusModel] = [:]

    static func status(messageID: String, text: String) -> CommandExecutionStatusModel? {
        let cacheKey = "\(messageID)|\(text.hashValue)"

        lock.lock()
        if let cached = statusByKey[cacheKey] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        guard let parsed = parse(text) else {
            return nil
        }

        lock.lock()
        if statusByKey.count >= maxEntries {
            statusByKey.removeAll(keepingCapacity: true)
        }
        statusByKey[cacheKey] = parsed
        lock.unlock()

        return parsed
    }

    private static func parse(_ text: String) -> CommandExecutionStatusModel? {
        let words = text.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.lowercased() else { return nil }
        let command = words.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        let commandLabel = command.isEmpty ? "command" : command

        switch first {
        case "running":
            return CommandExecutionStatusModel(command: commandLabel, statusLabel: "running", accent: .running)
        case "completed":
            return CommandExecutionStatusModel(command: commandLabel, statusLabel: "completed", accent: .completed)
        case "failed", "stopped":
            return CommandExecutionStatusModel(command: commandLabel, statusLabel: first, accent: .failed)
        default:
            return nil
        }
    }
}

enum FileChangeSystemRenderCache {
    static let maxEntries = 256
    static let lock = NSLock()
    static var stateByKey: [String: FileChangeRenderState] = [:]

    // Caches file-change parse artifacts to keep scrolling smooth on long patch threads.
    static func renderState(messageID: String, sourceText: String) -> FileChangeRenderState {
        let cacheKey = "\(messageID)|\(sourceText.hashValue)"

        lock.lock()
        if let cached = stateByKey[cacheKey] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let summary = TurnFileChangeSummaryParser.parse(from: sourceText)
        let actionEntries = summary?.entries.filter { $0.action != nil } ?? []
        let bodyText = actionEntries.isEmpty
            ? sourceText
            : TurnFileChangeSummaryParser.removingInlineEditingRows(from: sourceText)
        let state = FileChangeRenderState(
            summary: summary,
            actionEntries: actionEntries,
            bodyText: bodyText
        )

        lock.lock()
        if stateByKey.count >= maxEntries {
            stateByKey.removeAll(keepingCapacity: true)
        }
        stateByKey[cacheKey] = state
        lock.unlock()

        return state
    }
}

struct FileChangeBlockPresentation: Equatable {
    let entries: [TurnFileChangeSummaryEntry]
    let bodyText: String
}

private struct FileChangeBlockAggregate {
    var path: String
    var additions: Int
    var deletions: Int
    var action: TurnFileChangeAction?
    var diffSections: [String]
    var lastTotalsSourceIndex: Int
}

private struct RawFileChangeDiffSection {
    let path: String
    let action: TurnFileChangeAction?
    let additions: Int
    let deletions: Int
    let diffCode: String
}

enum FileChangeBlockPresentationBuilder {
    static func build(from messages: [ChatMessage]) -> FileChangeBlockPresentation? {
        guard !messages.isEmpty else {
            return nil
        }

        var aggregates: [FileChangeBlockAggregate] = []
        aggregates.reserveCapacity(messages.count)

        for (messageIndex, message) in messages.enumerated() {
            let parsedEntries = TurnFileChangeSummaryParser.parse(from: message.text)?.entries ?? []
            let diffSections = RawFileChangeDiffSectionParser.parse(
                bodyText: message.text,
                fallbackPaths: parsedEntries.map(\.path)
            )

            for section in diffSections {
                mergeDiffSection(section, sourceIndex: messageIndex, into: &aggregates)
            }

            for entry in parsedEntries {
                mergeSummaryEntry(entry, sourceIndex: messageIndex, into: &aggregates)
            }
        }

        let entries = aggregates.map { aggregate in
            TurnFileChangeSummaryEntry(
                path: aggregate.path,
                additions: aggregate.additions,
                deletions: aggregate.deletions,
                action: aggregate.action
            )
        }
        guard !entries.isEmpty else {
            return nil
        }

        let bodyText = aggregates.map { aggregate in
            let action = aggregate.action?.rawValue.lowercased() ?? "edited"
            let diffBody = aggregate.diffSections.isEmpty
                ? ""
                : """

                ```diff
                \(aggregate.diffSections.joined(separator: "\n\n"))
                ```
                """

            return """
            Path: \(aggregate.path)
            Kind: \(action)
            Totals: +\(aggregate.additions) -\(aggregate.deletions)\(diffBody)
            """
        }
        .joined(separator: "\n\n---\n\n")

        return FileChangeBlockPresentation(entries: entries, bodyText: bodyText)
    }

    private static func mergeSummaryEntry(
        _ entry: TurnFileChangeSummaryEntry,
        sourceIndex: Int,
        into aggregates: inout [FileChangeBlockAggregate]
    ) {
        if let existingIndex = aggregates.firstIndex(where: {
            FileChangePathIdentity.representsSameFile($0.path, entry.path)
        }) {
            let existing = aggregates[existingIndex]
            var updated = existing
            updated.path = FileChangePathIdentity.preferredDisplayPath(existing.path, entry.path)
            updated.action = mergedFileChangeAction(existing: existing.action, incoming: entry.action)

            if sourceIndex >= existing.lastTotalsSourceIndex {
                updated.additions = entry.additions
                updated.deletions = entry.deletions
                updated.lastTotalsSourceIndex = sourceIndex
            }

            aggregates[existingIndex] = updated
            return
        }

        aggregates.append(
            FileChangeBlockAggregate(
                path: entry.path,
                additions: entry.additions,
                deletions: entry.deletions,
                action: entry.action,
                diffSections: [],
                lastTotalsSourceIndex: sourceIndex
            )
        )
    }

    private static func mergeDiffSection(
        _ section: RawFileChangeDiffSection,
        sourceIndex: Int,
        into aggregates: inout [FileChangeBlockAggregate]
    ) {
        let normalizedDiff = section.diffCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedDiff.isEmpty else {
            return
        }

        if let existingIndex = aggregates.firstIndex(where: {
            FileChangePathIdentity.representsSameFile($0.path, section.path)
        }) {
            var existing = aggregates[existingIndex]
            existing.path = FileChangePathIdentity.preferredDisplayPath(existing.path, section.path)
            existing.action = mergedFileChangeAction(existing: existing.action, incoming: section.action)

            if existing.diffSections.contains(normalizedDiff) {
                aggregates[existingIndex] = existing
                return
            }

            if existing.diffSections.isEmpty {
                existing.additions = section.additions
                existing.deletions = section.deletions
            } else {
                existing.additions += section.additions
                existing.deletions += section.deletions
            }
            existing.lastTotalsSourceIndex = max(existing.lastTotalsSourceIndex, sourceIndex)
            existing.diffSections.append(normalizedDiff)
            aggregates[existingIndex] = existing
            return
        }

        aggregates.append(
            FileChangeBlockAggregate(
                path: section.path,
                additions: section.additions,
                deletions: section.deletions,
                action: section.action,
                diffSections: [normalizedDiff],
                lastTotalsSourceIndex: sourceIndex
            )
        )
    }

    private static func mergedFileChangeAction(
        existing: TurnFileChangeAction?,
        incoming: TurnFileChangeAction?
    ) -> TurnFileChangeAction? {
        switch (existing, incoming) {
        case let (lhs?, rhs?) where lhs == rhs:
            return lhs
        case (.added, _), (_, .added):
            return .added
        case (.deleted, _), (_, .deleted):
            return .deleted
        case (.renamed, _), (_, .renamed):
            return .renamed
        case let (lhs?, nil):
            return lhs
        case let (nil, rhs?):
            return rhs
        case (.edited, _), (_, .edited):
            return .edited
        case (nil, nil):
            return nil
        }
    }
}

// ─── Per-File Diff Chunk ────────────────────────────────────────────

struct PerFileDiffChunk: Identifiable {
    let id: String
    let path: String
    let action: TurnFileChangeAction
    let additions: Int
    let deletions: Int
    let diffCode: String

    var compactPath: String {
        if let last = path.split(separator: "/").last { return String(last) }
        return path
    }

    var fullDirectoryPath: String? {
        let components = path.split(separator: "/")
        guard components.count > 1 else { return nil }
        return components.dropLast().joined(separator: "/")
    }
}

enum FileChangePathIdentity {
    static func representsSameFile(_ lhs: String, _ rhs: String) -> Bool {
        let normalizedLHS = normalizedPath(lhs)
        let normalizedRHS = normalizedPath(rhs)

        guard !normalizedLHS.isEmpty, !normalizedRHS.isEmpty else {
            return false
        }
        if normalizedLHS == normalizedRHS {
            return true
        }

        let lhsIsAbsolute = isAbsolutePath(lhs)
        let rhsIsAbsolute = isAbsolutePath(rhs)
        guard lhsIsAbsolute != rhsIsAbsolute else {
            return false
        }

        let absolutePath = lhsIsAbsolute ? normalizedLHS : normalizedRHS
        let relativePath = lhsIsAbsolute ? normalizedRHS : normalizedLHS
        guard relativePath.contains("/") else {
            return false
        }

        return absolutePath.hasSuffix("/" + relativePath)
    }

    static func preferredDisplayPath(_ lhs: String, _ rhs: String) -> String {
        let trimmedLHS = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRHS = rhs.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedLHS.isEmpty { return trimmedRHS }
        if trimmedRHS.isEmpty { return trimmedLHS }
        if trimmedLHS == trimmedRHS { return trimmedLHS }
        if representsSameFile(trimmedLHS, trimmedRHS) {
            return trimmedLHS.count <= trimmedRHS.count ? trimmedLHS : trimmedRHS
        }
        return trimmedLHS
    }

    static func normalizedPath(_ rawPath: String) -> String {
        var normalized = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.hasPrefix("a/") || normalized.hasPrefix("b/") {
            normalized = String(normalized.dropFirst(2))
        }
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }
        if let range = normalized.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) {
            normalized.removeSubrange(range)
        }
        return normalized.lowercased()
    }

    private static func isAbsolutePath(_ rawPath: String) -> Bool {
        rawPath.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
    }
}

private enum RawFileChangeDiffSectionParser {
    static func parse(bodyText: String, fallbackPaths: [String]) -> [RawFileChangeDiffSection] {
        let sections = bodyText.components(separatedBy: "\n\n---\n\n")
        if sections.count > 1 {
            return sections.enumerated().compactMap { index, section in
                parseSection(
                    lines: section.split(separator: "\n", omittingEmptySubsequences: false).map(String.init),
                    fallbackPath: index < fallbackPaths.count ? fallbackPaths[index] : nil
                )
            }
        }

        let lines = bodyText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var rawSections: [RawFileChangeDiffSection] = []
        var currentPath: String?
        var i = 0

        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)
            if let parsedPath = extractPath(from: [trimmed]) {
                currentPath = parsedPath
                i += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                i += 1
                var codeLines: [String] = []
                while i < lines.count {
                    let candidate = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)
                    if candidate == "```" { break }
                    codeLines.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 }

                let code = codeLines.joined(separator: "\n")
                if TurnDiffLineKind.detectVerifiedPatch(in: code) {
                    let resolvedPath = currentPath
                        ?? parsePathFromDiff(lines: codeLines)
                        ?? (rawSections.count < fallbackPaths.count ? fallbackPaths[rawSections.count] : nil)
                    if let resolvedPath, !resolvedPath.isEmpty {
                        let totals = countDiffLines(in: codeLines)
                        rawSections.append(
                            RawFileChangeDiffSection(
                                path: resolvedPath,
                                action: detectAction(from: codeLines),
                                additions: totals.additions,
                                deletions: totals.deletions,
                                diffCode: code
                            )
                        )
                    }
                    currentPath = nil
                }
                continue
            }

            i += 1
        }

        return rawSections
    }

    private static func parseSection(lines: [String], fallbackPath: String?) -> RawFileChangeDiffSection? {
        guard let code = extractFencedCode(from: lines),
              TurnDiffLineKind.detectVerifiedPatch(in: code) else {
            return nil
        }
        let resolvedPath = extractPath(from: lines) ?? fallbackPath
        guard let resolvedPath, !resolvedPath.isEmpty else {
            return nil
        }

        let codeLines = code.components(separatedBy: "\n")
        let totals = countDiffLines(in: codeLines)
        return RawFileChangeDiffSection(
            path: resolvedPath,
            action: extractKind(from: lines) ?? detectAction(from: codeLines),
            additions: totals.additions,
            deletions: totals.deletions,
            diffCode: code
        )
    }

    private static func extractPath(from lines: [String]) -> String? {
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("**Path:**") || trimmed.hasPrefix("Path:") {
                let raw = trimmed
                    .replacingOccurrences(of: "**Path:**", with: "")
                    .replacingOccurrences(of: "Path:", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "`"))
                if !raw.isEmpty {
                    return raw
                }
            }
        }
        return nil
    }

    private static func extractKind(from lines: [String]) -> TurnFileChangeAction? {
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.lowercased().hasPrefix("kind:") else { continue }
            let value = trimmed.dropFirst("Kind:".count).trimmingCharacters(in: .whitespacesAndNewlines)
            return TurnFileChangeAction.fromKind(String(value))
        }
        return nil
    }

    private static func extractFencedCode(from lines: [String]) -> String? {
        var inFence = false
        var codeLines: [String] = []
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("```") {
                if inFence {
                    return codeLines.joined(separator: "\n")
                }
                inFence = true
                codeLines = []
                continue
            }
            if inFence {
                codeLines.append(line)
            }
        }
        return inFence ? codeLines.joined(separator: "\n") : nil
    }

    private static func parsePathFromDiff(lines: [String]) -> String? {
        for line in lines where line.hasPrefix("+++ ") {
            let candidate = normalizeDiffPath(String(line.dropFirst(4)))
            if !candidate.isEmpty {
                return candidate
            }
        }

        for line in lines where line.hasPrefix("diff --git ") {
            let components = line.split(separator: " ", omittingEmptySubsequences: true)
            if components.count >= 4 {
                let candidate = normalizeDiffPath(String(components[3]))
                if !candidate.isEmpty {
                    return candidate
                }
            }
        }

        return nil
    }

    private static func normalizeDiffPath(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "/dev/null" else { return "" }
        if trimmed.hasPrefix("a/") || trimmed.hasPrefix("b/") {
            return String(trimmed.dropFirst(2))
        }
        return trimmed
    }

    private static func countDiffLines(in lines: [String]) -> TurnDiffLineTotals {
        var totals = TurnDiffLineTotals()
        for line in lines {
            if line.isEmpty || isDiffMetadataLine(line) {
                continue
            }
            if line.hasPrefix("+") {
                totals.additions += 1
            } else if line.hasPrefix("-") {
                totals.deletions += 1
            }
        }
        return totals
    }

    private static func detectAction(from lines: [String]) -> TurnFileChangeAction? {
        if lines.contains(where: { $0.hasPrefix("rename from ") || $0.hasPrefix("rename to ") }) {
            return .renamed
        }
        if lines.contains(where: { $0.hasPrefix("new file mode ") || $0 == "--- /dev/null" }) {
            return .added
        }
        if lines.contains(where: { $0.hasPrefix("deleted file mode ") || $0 == "+++ /dev/null" }) {
            return .deleted
        }
        return .edited
    }

    private static func isDiffMetadataLine(_ line: String) -> Bool {
        let metadataPrefixes = [
            "+++",
            "---",
            "diff --git",
            "@@",
            "index ",
            "\\ No newline",
            "new file mode",
            "deleted file mode",
            "similarity index",
            "rename from",
            "rename to",
        ]

        return metadataPrefixes.contains { line.hasPrefix($0) }
    }
}

// ─── Per-File Diff Parser ───────────────────────────────────────────

enum PerFileDiffParser {
    static func parse(bodyText: String, entries: [TurnFileChangeSummaryEntry]) -> [PerFileDiffChunk] {
        let sections = bodyText.components(separatedBy: "\n\n---\n\n")

        if sections.count <= 1 {
            return singleChunkFallback(bodyText: bodyText, entries: entries)
        }

        var chunks: [PerFileDiffChunk] = []
        for (index, section) in sections.enumerated() {
            let lines = section.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            let path = extractPath(from: lines)
            let code = extractFencedCode(from: lines)

            let resolvedPath = path ?? (index < entries.count ? entries[index].path : "file-\(index)")
            let entry = entries.first { $0.path == resolvedPath }

            chunks.append(PerFileDiffChunk(
                id: "\(index)-\(resolvedPath)",
                path: resolvedPath,
                action: entry?.action ?? .edited,
                additions: entry?.additions ?? 0,
                deletions: entry?.deletions ?? 0,
                diffCode: code ?? ""
            ))
        }
        return consolidate(chunks: chunks)
    }

    private static func singleChunkFallback(bodyText: String, entries: [TurnFileChangeSummaryEntry]) -> [PerFileDiffChunk] {
        // Try to split by fenced diff blocks associated with Path: lines
        let lines = bodyText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var chunks: [PerFileDiffChunk] = []
        var currentPath: String?
        var i = 0

        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)

            if trimmed.hasPrefix("**Path:**") || trimmed.hasPrefix("Path:") {
                let raw = trimmed
                    .replacingOccurrences(of: "**Path:**", with: "")
                    .replacingOccurrences(of: "Path:", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "`"))
                if !raw.isEmpty { currentPath = raw }
                i += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                i += 1
                var codeLines: [String] = []
                while i < lines.count {
                    let candidate = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)
                    if candidate == "```" { break }
                    codeLines.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 }

                let code = codeLines.joined(separator: "\n")
                if TurnDiffLineKind.detectVerifiedPatch(in: code) {
                    let resolvedPath = currentPath ?? (chunks.count < entries.count ? entries[chunks.count].path : "file-\(chunks.count)")
                    let entry = entries.first { $0.path == resolvedPath }
                    chunks.append(PerFileDiffChunk(
                        id: "\(chunks.count)-\(resolvedPath)",
                        path: resolvedPath,
                        action: entry?.action ?? .edited,
                        additions: entry?.additions ?? 0,
                        deletions: entry?.deletions ?? 0,
                        diffCode: code
                    ))
                    currentPath = nil
                }
                continue
            }

            i += 1
        }

        if chunks.isEmpty, !entries.isEmpty {
            // Ultimate fallback: one chunk per entry with the whole body
            let allCode = extractFencedCode(from: lines) ?? bodyText
            let first = entries[0]
            chunks.append(PerFileDiffChunk(
                id: "0-\(first.path)",
                path: first.path,
                action: first.action ?? .edited,
                additions: first.additions,
                deletions: first.deletions,
                diffCode: allCode
            ))
        }

        return consolidate(chunks: chunks)
    }

    private static func extractPath(from lines: [String]) -> String? {
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.hasPrefix("**Path:**") || t.hasPrefix("Path:") {
                let raw = t
                    .replacingOccurrences(of: "**Path:**", with: "")
                    .replacingOccurrences(of: "Path:", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "`"))
                if !raw.isEmpty { return raw }
            }
        }
        return nil
    }

    private static func extractFencedCode(from lines: [String]) -> String? {
        var inFence = false
        var codeLines: [String] = []
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.hasPrefix("```") {
                if inFence {
                    return codeLines.joined(separator: "\n")
                } else {
                    inFence = true
                    codeLines = []
                }
                continue
            }
            if inFence { codeLines.append(line) }
        }
        return inFence ? codeLines.joined(separator: "\n") : nil
    }

    private static func consolidate(chunks: [PerFileDiffChunk]) -> [PerFileDiffChunk] {
        guard chunks.count > 1 else {
            return chunks
        }

        var consolidated: [PerFileDiffChunk] = []
        consolidated.reserveCapacity(chunks.count)

        for chunk in chunks {
            if let existingIndex = consolidated.firstIndex(where: {
                FileChangePathIdentity.representsSameFile($0.path, chunk.path)
            }) {
                let existing = consolidated[existingIndex]
                let isExactDuplicate = existing.diffCode.trimmingCharacters(in: .whitespacesAndNewlines)
                    == chunk.diffCode.trimmingCharacters(in: .whitespacesAndNewlines)
                    && existing.additions == chunk.additions
                    && existing.deletions == chunk.deletions
                    && existing.action == chunk.action
                let mergedDiff = mergedDiffCode(existing.diffCode, chunk.diffCode)
                consolidated[existingIndex] = PerFileDiffChunk(
                    id: existing.id,
                    path: FileChangePathIdentity.preferredDisplayPath(existing.path, chunk.path),
                    action: mergedAction(existing.action, chunk.action),
                    additions: isExactDuplicate ? existing.additions : (existing.additions + chunk.additions),
                    deletions: isExactDuplicate ? existing.deletions : (existing.deletions + chunk.deletions),
                    diffCode: mergedDiff
                )
            } else {
                consolidated.append(chunk)
            }
        }

        return consolidated
    }

    private static func mergedDiffCode(_ lhs: String, _ rhs: String) -> String {
        let trimmedLHS = lhs.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRHS = rhs.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmedLHS.isEmpty { return trimmedRHS }
        if trimmedRHS.isEmpty { return trimmedLHS }
        if trimmedLHS == trimmedRHS { return trimmedLHS }
        return "\(trimmedLHS)\n\n\(trimmedRHS)"
    }

    private static func mergedAction(
        _ lhs: TurnFileChangeAction,
        _ rhs: TurnFileChangeAction
    ) -> TurnFileChangeAction {
        if lhs == rhs {
            return lhs
        }
        let precedence: [TurnFileChangeAction] = [.added, .deleted, .renamed, .edited]
        let lhsRank = precedence.firstIndex(of: lhs) ?? precedence.count
        let rhsRank = precedence.firstIndex(of: rhs) ?? precedence.count
        return lhsRank <= rhsRank ? lhs : rhs
    }
}

// ─── Per-File Diff Chunk Cache ──────────────────────────────────────

enum PerFileDiffChunkCache {
    static let maxEntries = 128
    static let lock = NSLock()
    static var cache: [String: [PerFileDiffChunk]] = [:]

    static func chunks(messageID: String, bodyText: String, entries: [TurnFileChangeSummaryEntry]) -> [PerFileDiffChunk] {
        let key = "\(messageID)|\(bodyText.hashValue)"

        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let parsed = PerFileDiffParser.parse(bodyText: bodyText, entries: entries)

        lock.lock()
        if cache.count >= maxEntries {
            cache.removeAll(keepingCapacity: true)
        }
        cache[key] = parsed
        lock.unlock()

        return parsed
    }
}

// ─── Code Comment Directive Content Cache ───────────────────────────

enum CodeCommentDirectiveContentCache {
    static let maxEntries = 256
    static let lock = NSLock()
    static var cache: [String: CodeCommentDirectiveContent] = [:]

    static func content(messageID: String, text: String) -> CodeCommentDirectiveContent {
        let key = "\(messageID)|\(text.hashValue)"

        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let parsed = CodeCommentDirectiveParser.parse(from: text)

        lock.lock()
        if cache.count >= maxEntries {
            cache.removeAll(keepingCapacity: true)
        }
        cache[key] = parsed
        lock.unlock()

        return parsed
    }
}

// ─── Thinking Disclosure Content Cache ──────────────────────────────

enum ThinkingDisclosureContentCache {
    static let maxEntries = 256
    static let lock = NSLock()
    static var cache: [String: ThinkingDisclosureContent] = [:]

    static func content(messageID: String, text: String) -> ThinkingDisclosureContent {
        let key = "\(messageID)|\(text.hashValue)"

        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let parsed = ThinkingDisclosureParser.parse(from: text)

        lock.lock()
        if cache.count >= maxEntries {
            cache.removeAll(keepingCapacity: true)
        }
        cache[key] = parsed
        lock.unlock()

        return parsed
    }
}

// ─── Diff Block Detection Cache ─────────────────────────────────────

enum DiffBlockDetectionCache {
    static let maxEntries = 512
    static let lock = NSLock()
    static var cache: [Int: Bool] = [:]

    static func isDiffBlock(code: String, profile: MarkdownRenderProfile) -> Bool {
        switch profile {
        case .assistantProse, .fileChangeSystem:
            break
        }

        let key = code.hashValue

        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let result = TurnDiffLineKind.detectVerifiedPatch(in: code)

        lock.lock()
        if cache.count >= maxEntries {
            cache.removeAll(keepingCapacity: true)
        }
        cache[key] = result
        lock.unlock()

        return result
    }
}

// ─── File Change Grouping Cache ─────────────────────────────────────

struct FileChangeGroup: Identifiable {
    let key: String
    let entries: [TurnFileChangeSummaryEntry]
    var id: String { key }
}

enum FileChangeGroupingCache {
    static let maxEntries = 256
    static let lock = NSLock()
    static var cache: [String: [FileChangeGroup]] = [:]

    static func grouped(messageID: String, entries: [TurnFileChangeSummaryEntry]) -> [FileChangeGroup] {
        var hasher = Hasher()
        hasher.combine(messageID)
        for entry in entries {
            hasher.combine(entry.path)
            hasher.combine(entry.action)
            hasher.combine(entry.additions)
            hasher.combine(entry.deletions)
        }
        let key = "\(hasher.finalize())"

        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        var order: [String] = []
        var dict: [String: [TurnFileChangeSummaryEntry]] = [:]
        for entry in entries {
            let groupKey = entry.action?.rawValue ?? "Edited"
            if dict[groupKey] == nil { order.append(groupKey) }
            dict[groupKey, default: []].append(entry)
        }
        let result = order.map { FileChangeGroup(key: $0, entries: dict[$0]!) }

        lock.lock()
        if cache.count >= maxEntries {
            cache.removeAll(keepingCapacity: true)
        }
        cache[key] = result
        lock.unlock()

        return result
    }
}
