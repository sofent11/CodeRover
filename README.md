<p align="center">
  <img src="CodexMobile/CodexMobile/Assets.xcassets/remodex-og.imageset/remodex-og2%20(1).png" alt="Remodex" />
</p>

# Remodex

[![npm version](https://img.shields.io/npm/v/remodex)](https://www.npmjs.com/package/remodex)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Control [Codex](https://openai.com/index/codex/) from your iPhone. Remodex is a local-first open-source bridge + iOS app that keeps the Codex runtime on your Mac and lets your phone connect through a paired encrypted channel over your LAN or tailnet.

It's fork from https://github.com/Emanuele-web04/remodex ,thanks to their original greate work

> **I am very early in this project. Expect bugs.**
>
> I am not actively accepting contributions yet. If you still want to help, read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Get the App

Build you self.

Once the app is installed, onboarding inside Remodex walks you through pairing and scanning the QR from inside the app.

If you scan the pairing QR with a generic camera or QR reader before installing the app, your device may treat the QR payload as plain text and open a web search instead of pairing.

## Architecture

```
┌──────────────┐       Paired session   ┌───────────────┐       stdin/stdout       ┌─────────────┐
│  Remodex iOS │ ◄────────────────────► │ remodex (Mac) │ ◄──────────────────────► │ codex       │
│  app         │    local / tailnet     │ bridge        │    JSON-RPC              │ app-server  │
└──────────────┘                        └───────────────┘                          └─────────────┘
                                               │                                         │
                                               │  AppleScript route bounce                │ JSONL rollout
                                               ▼                                         ▼
                                        ┌─────────────┐                           ┌─────────────┐
                                        │  Codex.app  │ ◄─── reads from ──────── │  ~/.codex/  │
                                        │  (desktop)  │      disk on navigate     │  sessions   │
                                        └─────────────┘                           └─────────────┘
```

1. Run `remodex up` on your Mac — a QR code appears in the terminal
2. Scan it with the Remodex iOS app to pair
3. Your phone sends instructions to Codex through the bridge and receives responses in real-time
4. The bridge handles git operations, desktop refresh, and session persistence locally

## Repository Structure

This is a monorepo with a local bridge, an iOS app target, and its tests:

```
├── phodex-bridge/                # Node.js bridge package used by `remodex`
│   ├── bin/                      # CLI entrypoints
│   └── src/                      # Bridge runtime, git/workspace handlers, refresh helpers
│
├── CodexMobile/                  # Xcode project root
│   ├── CodexMobile/              # App source target
│   │   ├── Services/             # Connection, sync, incoming-event, git, and persistence logic
│   │   ├── Views/                # SwiftUI screens and timeline/sidebar components
│   │   ├── Models/               # RPC, thread, message, and UI models
│   │   └── Assets.xcassets/      # App icons and UI assets
│   ├── CodexMobileTests/         # Unit tests
│   ├── CodexMobileUITests/       # UI tests
│   └── BuildSupport/             # Info.plist and build-time support files
```

## Prerequisites

- **Node.js** v18+
- **[Codex CLI](https://github.com/openai/codex)** installed and in your PATH
- **[Codex desktop app](https://openai.com/index/codex/)** (optional — for viewing threads on your Mac)
- **[Remodex iOS app via TestFlight](https://testflight.apple.com/join/PKZhBUVM)** installed on your iPhone or iPad before scanning the pairing QR
- **macOS** (for desktop refresh features — the core bridge works on any OS)
- **Xcode 16+** (only if building the iOS app from source)

## Install the Bridge

```sh
npm install -g remodex
```

To update an existing global install later:

```sh
npm install -g remodex@latest
```

If you only want to try Remodex, you can install it from npm and run it without cloning this repository.

## Quick Start

```sh
remodex up
```

Open the Remodex app, follow the onboarding flow, then scan the QR code from inside the app and start coding.

## Local Development

```sh
cd phodex-bridge
npm install
npm start
```

## Commands

### `remodex up`

Starts the bridge:

- Spawns `codex app-server` (or connects to an existing endpoint)
- Starts a stable local WebSocket bridge endpoint on your Mac
- Displays a QR code for phone pairing
- Forwards JSON-RPC messages bidirectionally
- Handles git commands from the phone
- Persists the active thread for later resumption

### `remodex resume`

Reopens the last active thread in Codex.app on your Mac.

```sh
remodex resume
# => [remodex] Opened last active thread: abc-123 (phone)
```

### `remodex watch [threadId]`

Tails the event log for a thread in real-time.

```sh
remodex watch
# => [14:32:01] Phone: "Fix the login bug in auth.ts"
# => [14:32:05] Codex: "I'll look at auth.ts and fix the login..."
# => [14:32:18] Task started
# => [14:33:42] Task complete
```

## Environment Variables

All optional. Sensible defaults are provided.

| Variable | Default | Description |
|----------|---------|-------------|
| `REMODEX_LOCAL_PORT` | `8765` | Stable local bridge port exposed by `remodex up` |
| `REMODEX_TAILNET_URL` | — | Optional tailnet URL prefix appended with `/bridge/<bridgeId>` for cross-network fallback |
| `REMODEX_CODEX_ENDPOINT` | — | Connect to an existing Codex WebSocket instead of spawning a local `codex app-server` |
| `REMODEX_REFRESH_ENABLED` | `false` | Auto-refresh Codex.app when phone activity is detected (`true` enables it explicitly) |
| `REMODEX_REFRESH_DEBOUNCE_MS` | `1200` | Debounce window (ms) for coalescing refresh events |
| `REMODEX_REFRESH_COMMAND` | — | Custom shell command to run instead of the built-in AppleScript refresh |
| `REMODEX_CODEX_BUNDLE_ID` | `com.openai.codex` | macOS bundle ID of the Codex app |
| `CODEX_HOME` | `~/.codex` | Codex data directory (used here for `sessions/` rollout files) |

```sh
# Enable desktop refresh explicitly
REMODEX_REFRESH_ENABLED=true remodex up

# Connect to an existing Codex instance
REMODEX_CODEX_ENDPOINT=ws://localhost:8080 remodex up

# Expose a stable local bridge on a custom port
REMODEX_LOCAL_PORT=9876 remodex up

# Add a tailnet fallback candidate
REMODEX_TAILNET_URL=wss://my-mac.tailnet.example remodex up

```

## Pairing and Safety

- Remodex is local-first: Codex, git operations, and workspace actions run on your Mac, while the iPhone acts as a paired remote control.
- The pairing QR now carries a stable bridge ID, encrypted Mac identity metadata, and an ordered list of transport candidates.
- The iPhone prefers direct local connections and can reuse a previously successful transport.
- If both devices are on the same tailnet, add `REMODEX_TAILNET_URL` so the QR code also carries a cross-network candidate.
- On the iPhone, the default agent permission mode is `On-Request`. Switching the app to `Full access` auto-approves runtime approval prompts from the agent.

## Security and Privacy

Remodex now uses an authenticated end-to-end encrypted channel between the paired iPhone and the bridge running on your Mac. The underlying LAN or tailnet transport does not get plaintext prompts, tool calls, Codex responses, git output, or workspace RPC payloads once the secure session is established.

The secure channel is built in these steps:

1. The bridge generates and persists a long-term device identity keypair on the Mac.
2. The pairing QR shares the stable bridge ID, bridge device ID, bridge identity public key, transport candidates, and a short expiry window.
3. During pairing, the iPhone and bridge exchange fresh X25519 ephemeral keys and nonces.
4. The bridge signs the handshake transcript with its Ed25519 identity key, and the iPhone verifies that signature against the public key from the QR code or the previously trusted Mac record.
5. The iPhone signs a client-auth transcript with its own Ed25519 identity key, and the bridge verifies that before accepting the session.
6. Both sides derive directional AES-256-GCM keys with HKDF-SHA256 and then wrap application messages in encrypted envelopes with monotonic counters for replay protection.

Privacy notes:

- The underlying transport can still see connection metadata and the plaintext secure control messages used to set up the encrypted session, including bridge IDs, device IDs, public keys, nonces, and handshake result codes.
- The transport does not see decrypted application payloads after the secure handshake succeeds.
- The bridge can trust multiple paired phone identities per Mac bridge state. Pairing a new iPhone adds it to the trusted set, and reconnecting the same iPhone only replaces that phone's older live connection.
- On-device message history is also encrypted at rest on iPhone using a Keychain-backed AES key.

## Git Integration

The bridge intercepts `git/*` JSON-RPC calls from the phone and executes them locally:

| Command | Description |
|---------|-------------|
| `git/status` | Branch, tracking info, dirty state, file list, and diff |
| `git/commit` | Commit staged changes with an optional message |
| `git/push` | Push to remote |
| `git/pull` | Pull from remote (auto-aborts on conflict) |
| `git/branches` | List all branches with current/default markers |
| `git/checkout` | Switch branches |
| `git/createBranch` | Create and switch to a new branch |
| `git/log` | Recent commit history |
| `git/stash` | Stash working changes |
| `git/stashPop` | Pop the latest stash |
| `git/resetToRemote` | Hard reset to remote (requires confirmation) |
| `git/remoteUrl` | Get the remote URL and owner/repo |

## Workspace Integration

The bridge also handles local workspace-scoped revert operations for the assistant revert flow:

| Command | Description |
|---------|-------------|
| `workspace/revertPatchPreview` | Checks whether a reverse patch can be applied cleanly in the local repo |
| `workspace/revertPatchApply` | Applies the reverse patch locally when the preview succeeds |

## Codex Desktop App Integration

Remodex works with both the Codex CLI and the Codex desktop app (`Codex.app`). Under the hood, the bridge spawns a `codex app-server` process — the same JSON-RPC interface that powers the desktop app and IDE extensions. Conversations are persisted as JSONL rollout files under `~/.codex/sessions`, so threads started from your phone show up in the desktop app too.

**Known limitation**: The Codex desktop app does not live-reload when an external `app-server` process writes new data to disk. Threads created or updated from your phone won't appear in the desktop app until it remounts that route. Remodex keeps desktop refresh off by default for now because the current deep-link bounce is still disruptive. You can still enable it manually if you want the old remount workaround.

```sh
# Enable the old deep-link refresh workaround manually
REMODEX_REFRESH_ENABLED=true remodex up
```

This triggers a debounced deep-link bounce (`codex://settings` → `codex://threads/<id>`) that forces the desktop app to remount the current thread without interrupting any running tasks. While a turn is running, Remodex also watches the persisted rollout for that thread and issues occasional throttled refreshes so long responses become visible on Mac without a full app relaunch. If the local desktop path is unavailable, the bridge self-disables desktop refresh for the rest of that run instead of retrying noisily forever.

## Connection Resilience

- **Stable bridge identity**: The Mac bridge persists one bridge ID across restarts so saved pairings stay reusable
- **Direct reconnect**: The iPhone keeps a list of transport candidates and retries them in order, preferring the last successful connection
- **Secure catch-up**: The bridge keeps a bounded local outbound buffer and re-sends missed encrypted messages after a secure reconnect
- **Codex persistence**: The Codex process stays alive across bridge reconnects
- **Graceful shutdown**: SIGINT/SIGTERM cleanly close all connections

## Building the iOS App

```sh
cd CodexMobile
open CodexMobile.xcodeproj
```

Build and run on a physical device or simulator with Xcode. The app uses SwiftUI and the current project target is iOS 18.6.

## Contributing

I'm not actively accepting contributions yet. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## FAQ

**Do I need an OpenAI API key?**
Not for Remodex itself. You need Codex CLI set up and working independently.

**Does this work on Linux/Windows?**
The core bridge (local socket + Codex forwarding + git) works on any OS. Desktop refresh (AppleScript) is macOS-only.

**What happens if I close the terminal?**
The bridge stops. Run `remodex up` again — your phone will reconnect when it detects one of the saved bridge transports again.

**Can I connect to a remote Codex instance?**
Yes — set `REMODEX_CODEX_ENDPOINT=ws://host:port` to skip spawning a local `codex app-server`.

**Why don't my phone threads show up in the Codex desktop app immediately?**
The desktop app reads session data from disk (`~/.codex/sessions`) but doesn't live-reload when an external process writes new data. Remodex keeps desktop refresh off by default for now because the current workaround bounces the Codex app route and can feel disruptive. If you still want that workaround, enable it explicitly with `REMODEX_REFRESH_ENABLED=true`.

**Do I need any hosted transport?**
No. Remodex now only uses direct local transport to the bridge running on your Mac, plus an optional tailnet URL when you explicitly configure one.

## License

[ISC](LICENSE)
