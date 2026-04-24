// FILE: TurnScrollStateTracker.swift
// Purpose: Contains pure rules for bottom-anchor scroll state transitions.
// Layer: View Helper
// Exports: TurnScrollStateTracker
// Depends on: CoreGraphics

import CoreGraphics

struct TurnScrollStateTracker {
    static let bottomThreshold: CGFloat = 12

    static func shouldShowScrollToLatestButton(messageCount: Int, isScrolledToBottom: Bool) -> Bool {
        messageCount > 0 && !isScrolledToBottom
    }

    static func shouldPreserveFollowBottomOnBottomLoss(
        wasScrolledToBottom: Bool,
        autoScrollIsFollowing: Bool,
        isUserInitiatedScroll: Bool
    ) -> Bool {
        wasScrolledToBottom && autoScrollIsFollowing && !isUserInitiatedScroll
    }

    static func nextIsScrolledToBottom(
        nextIsAtBottom: Bool,
        wasScrolledToBottom: Bool,
        autoScrollIsFollowing: Bool,
        isUserInitiatedScroll: Bool
    ) -> Bool {
        if nextIsAtBottom {
            return true
        }
        return shouldPreserveFollowBottomOnBottomLoss(
            wasScrolledToBottom: wasScrolledToBottom,
            autoScrollIsFollowing: autoScrollIsFollowing,
            isUserInitiatedScroll: isUserInitiatedScroll
        )
    }

    static func shouldEnterManualMode(
        nextIsAtBottom: Bool,
        isUserInitiatedScroll: Bool
    ) -> Bool {
        !nextIsAtBottom && isUserInitiatedScroll
    }
}
