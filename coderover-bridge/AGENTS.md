# CodeRover Agents & ACP

CodeRover Bridge is built around the **Agent Control Protocol (ACP)**, a JSON-RPC-based protocol that allows a **Host** (the bridge) to control and communicate with an **Agent** (AI coding tools like Codex or Claude) via standard input and output (stdio).

## Built-in Agents

The bridge comes pre-configured with support for the following agents:

| Agent ID | Name | Default Command | Description |
|----------|------|-----------------|-------------|
| `codex` | Codex | `npx @zed-industries/codex-acp` | High-fidelity coding agent. |
| `claude` | Claude | `npx -y @zed-industries/claude-agent-acp` | Claude Code with ACP adapter. |
| `gemini` | Gemini | `gemini --acp` | Gemini CLI in ACP mode. |

### Default Capabilities

Built-in agents are configured with specific capability sets (e.g., whether they support `planMode`, `inlineApproval`, or `desktopRefresh`). These are automatically reported to the mobile app to adjust the UI accordingly.

## Customizing Agents

You can override the default command for any built-in agent using environment variables:

```sh
# Override Codex command
CODEROVER_CODEX_ACP_COMMAND="custom-codex --acp-mode" coderover up

# Override Claude command
CODEROVER_CLAUDE_ACP_COMMAND="npx local-claude-adapter" coderover up
```

## How it Works

1.  **Selection**: When you select an agent on your phone, the bridge spawns a child process using the configured command.
2.  **ACP Handshake**: The bridge (Host) and the agent (Client) perform an `initialize` handshake to exchange versions and capabilities.
3.  **Communication**: Prompts from your phone are forwarded to the agent as `session/prompt`. Updates from the agent (deltas, tool calls, reasoning) are streamed back to your phone in real-time.
4.  **Local Context**: The bridge handles local services like `git/*` and `workspace/*` that might be requested by the mobile app UI independently of the agent.

## Future Agents

Any agent that implements the **ACP protocol** can be used with CodeRover Bridge. To add a new agent, you can currently override one of the existing IDs or contribute a new builtin agent to `src/acp/agent-registry.ts`.
