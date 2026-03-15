declare module "@anthropic-ai/claude-agent-sdk" {
  export interface ClaudeAgentSdkSession {
    sessionId?: string;
    customTitle?: unknown;
    summary?: unknown;
    firstPrompt?: unknown;
    cwd?: unknown;
    lastModified?: unknown;
  }

  export interface ClaudeAgentSdkHistoryMessage {
    uuid?: string;
    type?: unknown;
    message?: unknown;
  }

  export interface ClaudeAgentSdkToolContext {
    toolUseID: string;
  }

  export interface ClaudeAgentSdkQueryMessage {
    type?: unknown;
    uuid?: string;
    session_id?: string;
    event?: unknown;
    message?: unknown;
    usage?: unknown;
    tool_use_id?: string;
  }

  export interface ClaudeAgentSdkQuery extends AsyncIterable<ClaudeAgentSdkQueryMessage> {
    interrupt(): Promise<void>;
  }

  export function listSessions(): Promise<ClaudeAgentSdkSession[]>;

  export function getSessionMessages(
    sessionId: string,
    options?: {
      dir?: string;
    }
  ): Promise<ClaudeAgentSdkHistoryMessage[]>;

  export function query(options: {
    prompt: string;
    options: {
      cwd: string;
      model: string | null;
      resume?: string;
      includePartialMessages: boolean;
      tools: {
        type: "preset";
        preset: "claude_code";
      };
      settingSources: string[];
      systemPrompt: {
        type: "preset";
        preset: "claude_code";
      };
      permissionMode: "plan" | "bypassPermissions" | "default";
      allowDangerouslySkipPermissions: boolean;
      canUseTool: (
        toolName: unknown,
        input: unknown,
        context: ClaudeAgentSdkToolContext
      ) => Promise<Record<string, unknown>>;
    };
  }): ClaudeAgentSdkQuery;
}
