# Contributing to CodeRover

I am not actively accepting contributions right now.

This project is very early. Things change fast, priorities shift, and I'm still figuring out the right direction. If you open a PR or issue, there's a good chance I close it, defer it, or never get to it. That's not personal — I just need to stay focused.

## If you still want to contribute

Read this whole file first.

### What I'm most likely to accept

- Small, focused bug fixes
- Small reliability or performance improvements
- Typo and documentation fixes

### What I'm least likely to accept

- Large PRs
- Drive-by feature work
- Opinionated rewrites or refactors
- Scope expansion I didn't ask for

### Before opening a PR

- **Open an issue first** for anything non-trivial. Describe the problem, not your solution.
- Keep changes minimal. One fix per PR.
- Explain exactly what changed and exactly why.
- If it touches UI, include a screenshot or video.

Opening a PR does not create an obligation on my side. I may close it. I may ignore it. I may take the idea and implement it differently. That's how early-stage projects work.

---

## Local Development Setup

### Prerequisites

- **Node.js** v18+
- **CodeRover CLI** installed and working
- **CodeRover desktop app** (optional — for viewing threads on Mac)
- **macOS** (required for desktop refresh; core bridge works on any OS)
- **Xcode 16+** (only for building the iOS app)
- **iPhone** with the CodeRover app (or built from source)

### Bridge setup

```sh
# Clone the repo
git clone https://github.com/Emanuele-web04/coderover.git
cd coderover/coderover-bridge

# Install dependencies
npm install

# Start the bridge
npm start
```

This runs `coderover up`, which:
1. Spawns a CodeRover `app-server` process
2. Starts a stable local bridge endpoint on your Mac
3. Prints a QR code in your terminal

Scan the QR code with the CodeRover iOS app to pair.

### iOS app setup

```sh
cd CodeRoverMobile
open CodeRoverMobile.xcodeproj
```

1. Select your team in **Signing & Capabilities** (you'll need an Apple Developer account)
2. Pick a target device (physical iPhone or simulator)
3. Build and run (Cmd+R)

The app uses SwiftUI and the current project target is iOS 18.6. No CocoaPods or SPM dependencies — it's a standalone Xcode project.

### Testing a full local session

1. Start the bridge: `cd coderover-bridge && npm start`
2. Open the iOS app and scan the QR code
3. Create a new thread from the app
4. Send a message — you should see CodeRover respond in real-time
5. Try git operations from the phone (commit, push, branch switching)

### Environment variables

All optional. Override defaults as needed:

```sh
# Local bridge port (used when you do not override anything)
# CODEROVER_LOCAL_PORT=8765

# Connect to an existing CodeRover instance instead of spawning one
CODEROVER_ENDPOINT=ws://localhost:8080 npm start

# Add a tailnet fallback candidate
CODEROVER_TAILNET_URL=wss://my-mac.tailnet.example npm start

# Add one explicit relay candidate to the QR payload
CODEROVER_RELAY_URL=wss://relay.example.com npm start

# Or advertise multiple relay candidates
CODEROVER_RELAY_URLS=wss://relay-a.example.com,wss://relay-b.example.com/coderover npm start

# Enable auto-refresh of CodeRover.app on Mac
CODEROVER_REFRESH_ENABLED=true npm start
```

### Project structure

```
coderover/
├── coderover-bridge/          # Node.js CLI bridge (npm package)
│   ├── bin/coderover.js      # CLI entrypoint
│   └── src/
│       ├── bridge.js               # Core local bridge + message forwarding
│       ├── coderover-transport.js      # Spawn vs WebSocket abstraction
│       ├── coderover-desktop-refresher.js  # Debounced CodeRover.app refresh
│       ├── git-handler.js          # Git command execution from phone
│       ├── workspace-handler.js    # Workspace/cwd management
│       ├── session-state.js        # Thread persistence (~/.coderover/)
│       ├── rollout-watch.js        # Thread event log tailing
│       └── qr.js                   # QR code generation
│
├── CodeRoverMobile/            # Xcode project root
│   ├── CodeRoverMobile/        # App source target
│   │   ├── Services/       # Core services
│   │   │   ├── CodeRoverService.swift              # Main service coordinator
│   │   │   ├── CodeRoverService+Connection.swift   # WebSocket connection
│   │   │   ├── CodeRoverService+Incoming.swift     # Message handling
│   │   │   ├── CodeRoverService+Messages.swift     # Message composition
│   │   │   ├── CodeRoverService+History.swift      # Thread history
│   │   │   ├── CodeRoverService+ThreadsTurns.swift # Thread/turn management
│   │   │   ├── GitActionsService.swift         # Git operations
│   │   │   └── AppEnvironment.swift            # Runtime config
│   │   ├── Views/          # SwiftUI views
│   │   │   ├── Turn/       # Message timeline + composer
│   │   │   ├── Sidebar/    # Project/thread navigation
│   │   │   └── Home/       # Home + onboarding
│   │   └── Models/         # Data models
│   ├── CodeRoverMobileTests/   # Unit tests
│   ├── CodeRoverMobileUITests/ # UI tests
│   └── BuildSupport/       # Build support files
```

### Code style

- **Bridge**: CommonJS, no transpilation, no TypeScript. Keep it simple.
- **iOS**: SwiftUI, async/await, MainActor isolation. Follow existing patterns.
- No linter or formatter is enforced — just match what's already there.

### Trust model

- The QR pairing is possession-based: it contains the stable bridge identity plus transport candidates.
- The default path is direct local transport to the Mac bridge; tailnet is an optional cross-network fallback.
- CodeRover keeps an authenticated end-to-end encryption layer above whichever transport is selected.
