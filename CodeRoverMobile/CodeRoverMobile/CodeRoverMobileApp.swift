// FILE: CodeRoverMobileApp.swift
// Purpose: App entry point and root dependency wiring for CodeRoverService.
// Layer: App
// Exports: CodeRoverMobileApp

import SwiftUI

@MainActor
@main
struct CodeRoverMobileApp: App {
    @State private var coderoverService: CodeRoverService

    init() {
        let service = CodeRoverService()
        service.configureNotifications()
        _coderoverService = State(initialValue: service)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(coderoverService)
                .task {
                    await coderoverService.requestNotificationPermissionOnFirstLaunchIfNeeded()
                }
        }
    }
}
