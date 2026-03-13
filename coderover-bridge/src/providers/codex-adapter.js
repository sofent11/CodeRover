// FILE: providers/codex-adapter.js
// Purpose: Thin adapter over the existing Codex app-server JSON-RPC transport.
// Layer: Runtime provider
// Exports: createCodexAdapter
// Depends on: ../rpc-client

const { createJsonRpcClient } = require("../rpc-client");

function createCodexAdapter({
  sendToClient,
  logPrefix = "[coderover]",
} = {}) {
  let rpcClient = null;

  function attachTransport(transport) {
    if (!transport) {
      rpcClient?.close(new Error("Codex transport detached"));
      rpcClient = null;
      return;
    }

    rpcClient?.close(new Error("Codex transport replaced"));
    rpcClient = createJsonRpcClient({
      sendRawMessage(message) {
        transport.send(message);
      },
      onUnhandledMessage(rawMessage, parsedMessage) {
        sendToClient?.(rawMessage, parsedMessage);
      },
    });
  }

  function handleIncomingRaw(rawMessage) {
    if (!rpcClient) {
      return;
    }
    rpcClient.handleIncomingRaw(rawMessage);
  }

  function handleTransportClosed(reason = "Codex transport closed") {
    rpcClient?.close(new Error(reason));
  }

  async function request(method, params) {
    if (!rpcClient) {
      throw new Error(`${logPrefix} Codex transport is not available`);
    }
    return rpcClient.request(method, params);
  }

  function notify(method, params) {
    if (!rpcClient) {
      throw new Error(`${logPrefix} Codex transport is not available`);
    }
    rpcClient.notify(method, params);
  }

  function sendRaw(rawMessage) {
    if (!rpcClient) {
      throw new Error(`${logPrefix} Codex transport is not available`);
    }
    rpcClient.sendRaw(rawMessage);
  }

  return {
    attachTransport,
    collaborationModes(params) {
      return request("collaborationMode/list", params);
    },
    compactThread(params) {
      return request("thread/compact/start", params);
    },
    fuzzyFileSearch(params) {
      return request("fuzzyFileSearch", params);
    },
    handleIncomingRaw,
    handleTransportClosed,
    interruptTurn(params) {
      return request("turn/interrupt", params);
    },
    isAvailable() {
      return Boolean(rpcClient);
    },
    listModels(params) {
      return request("model/list", params);
    },
    listSkills(params) {
      return request("skills/list", params);
    },
    listThreads(params) {
      return request("thread/list", params);
    },
    notify,
    request,
    readThread(params) {
      return request("thread/read", params);
    },
    resumeThread(params) {
      return request("thread/resume", params);
    },
    sendRaw,
    startThread(params) {
      return request("thread/start", params);
    },
    startTurn(params) {
      return request("turn/start", params);
    },
    steerTurn(params) {
      return request("turn/steer", params);
    },
  };
}

module.exports = {
  createCodexAdapter,
};
