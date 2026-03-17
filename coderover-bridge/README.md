<p align="center">
  <img src="CodeRoverMobile/CodeRoverMobile/Assets.xcassets/coderover-og.imageset/coderover-og2%20(1).png" alt="CodeRover" />
</p>

# CodeRover Bridge

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

**CodeRover Bridge** is a local-first, multi-agent remote control tool. It acts as a secure communication hub between the **CodeRover Mobile App** (iOS/Android) and various AI agents (like Codex, Claude, or Gemini) using the **Agent Control Protocol (ACP)**.

The bridge runs on your Mac/Linux machine, exposing a secure WebSocket server that your phone connects to over LAN, Tailnet, or a relay. It then communicates with AI agents locally via ACP (JSON-RPC over stdio).

## Key Features

- **Multi-Agent Support**: Control any ACP-compliant agent (Codex, Claude, Gemini, etc.) from one app.
- **Secure End-to-End Encryption**: Authenticated and encrypted channel between your phone and the bridge.
- **Local-First**: Your code and agents stay on your machine; the phone is just the remote control.
- **Git & Workspace Integration**: Execute git operations and workspace reverts directly from your phone.
- **Desktop Synchronization**: Real-time sync with the CodeRover desktop app for a seamless multi-device experience.

## Architecture

```
┌────────────────┐       Secure WS (ACP)      ┌──────────────────┐       stdio (ACP)      ┌──────────────┐
│  CodeRover App │ <────────────────────────> │ CodeRover Bridge │ <────────────────────> │  AI Agent    │
│ (iOS/Android)  │       LAN / Tailnet        │     (Host)       │       JSON-RPC         │ (Codex/etc.) │
└────────────────┘                            └──────────────────┘                        └──────────────┘
                                                 │              │
                                   Local Services│              │Desktop Sync
                                                 ▼              ▼
                                          ┌──────────────┐      ┌────────────────┐
                                          │ Git / FS /   │      │ CodeRover.app  │
                                          │ Workspace    │      │ (Desktop)      │
                                          └──────────────┘      └────────────────┘
```

## Quick Start

1.  **Install the Bridge**:
    ```sh
    bun add -g coderover
    ```
2.  **Start the Bridge**:
    ```sh
    coderover up
    ```
    A QR code will appear in your terminal.
3.  **Pair your Phone**: Open the CodeRover mobile app and scan the QR code.
4.  **Start Coding**: Select an agent and start a conversation.

## Agents

CodeRover Bridge supports multiple AI agents via the Agent Control Protocol (ACP). Built-in agents include:
- **Codex**: Optimized for high-fidelity coding tasks.
- **Claude**: Using the Claude ACP adapter.
- **Gemini**: Using the Gemini CLI in ACP mode.

For details on configuring and adding agents, see [AGENTS.md](AGENTS.md).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEROVER_LOCAL_PORT` | `8765` | Local bridge port exposed by `coderover up` |
| `CODEROVER_TAILNET_URL` | — | Optional Tailnet URL for cross-network fallback |
| `CODEROVER_RELAY_URLS` | — | Comma-separated relay URLs for public access |
| `CODEROVER_CODEX_ACP_COMMAND` | `npx @zed-industries/codex-acp` | Command to start the Codex agent |
| `CODEROVER_CLAUDE_ACP_COMMAND` | `npx -y @zed-industries/claude-agent-acp` | Command to start the Claude agent |
| `CODEROVER_GEMINI_ACP_COMMAND` | `gemini --acp` | Command to start the Gemini agent |

## Local Development

```sh
cd coderover-bridge
bun install
bun run build
bun run start
```

## Security

CodeRover Bridge uses an authenticated end-to-end encrypted channel (AES-256-GCM) between the paired phone and the bridge. Handshakes are secured via X25519 and signed with Ed25519 identity keys.

## License

[ISC](LICENSE)
