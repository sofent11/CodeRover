# CodeRover Android

Android client for the local-first CodeRover bridge, implemented with Kotlin and Jetpack Compose.

Current coverage:

- Compose shell aligned with iOS information architecture: onboarding, pairing entry, home, drawer/sidebar, conversation, settings.
- Local bridge connection skeleton with the CodeRover secure handshake (`clientHello` -> `serverHello` -> `clientAuth` -> `secureReady` -> `resumeState`).
- Encrypted JSON-RPC transport, saved pairings, trusted Mac registry, and persistent phone identity.
- Basic thread list, thread history hydration, optimistic send, turn stop, and approval prompt handling.

Not yet covered:

- Camera QR scanning.
- Git toolbars, attachment flows, autocomplete, archived chats UI, and iOS-complete timeline rendering.
- Push notifications and encrypted transcript persistence parity.

Open this folder as a standalone Android Studio project (`CodeRoverAndroid/`).
