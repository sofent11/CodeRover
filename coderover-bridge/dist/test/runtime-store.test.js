"use strict";
// FILE: runtime-store.test.ts
// Purpose: Verifies provider-aware overlay persistence for managed runtime threads.
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runtime_store_1 = require("../src/runtime-store");
function createTempStore() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-store-"));
    const store = (0, runtime_store_1.createRuntimeStore)({ baseDir });
    return {
        store,
        cleanup() {
            store.shutdown();
            fs.rmSync(baseDir, { recursive: true, force: true });
        },
    };
}
(0, node_test_1.test)("runtime store persists provider session mappings and thread history", () => {
    const fixture = createTempStore();
    try {
        const created = fixture.store.createThread({
            provider: "claude",
            providerSessionId: "session-1",
            title: "Claude thread",
            cwd: "/tmp/project-a",
        });
        node_assert_1.strict.match(created.id, /^claude:/);
        node_assert_1.strict.equal(fixture.store.findThreadIdByProviderSession("claude", "session-1"), created.id);
        fixture.store.bindProviderSession(created.id, "claude", "session-2");
        node_assert_1.strict.equal(fixture.store.findThreadIdByProviderSession("claude", "session-1"), null);
        node_assert_1.strict.equal(fixture.store.findThreadIdByProviderSession("claude", "session-2"), created.id);
        fixture.store.saveThreadHistory(created.id, {
            threadId: created.id,
            turns: [
                {
                    id: "turn-1",
                    createdAt: "2026-03-13T00:00:00.000Z",
                    status: "completed",
                    items: [
                        {
                            id: "item-1",
                            type: "agent_message",
                            role: "assistant",
                            text: "hello",
                            content: [{ type: "text", text: "hello" }],
                        },
                    ],
                },
            ],
        });
        const history = fixture.store.getThreadHistory(created.id);
        node_assert_1.strict.equal(history?.turns?.length, 1);
        node_assert_1.strict.equal(history?.turns?.[0]?.items?.[0]?.text, "hello");
    }
    finally {
        fixture.cleanup();
    }
});
(0, node_test_1.test)("runtime store keeps archive and name overlays in the thread index", () => {
    const fixture = createTempStore();
    try {
        const created = fixture.store.createThread({
            provider: "gemini",
            providerSessionId: "chat-1",
            title: "Gemini thread",
            preview: "draft",
        });
        fixture.store.updateThreadMeta(created.id, (entry) => ({
            ...entry,
            name: "Renamed Gemini thread",
            archived: true,
        }));
        const updated = fixture.store.getThreadMeta(created.id);
        node_assert_1.strict.equal(updated?.name, "Renamed Gemini thread");
        node_assert_1.strict.equal(updated?.archived, true);
        fixture.store.deleteThread(created.id);
        node_assert_1.strict.equal(fixture.store.getThreadMeta(created.id), null);
        node_assert_1.strict.equal(fixture.store.findThreadIdByProviderSession("gemini", "chat-1"), null);
    }
    finally {
        fixture.cleanup();
    }
});
(0, node_test_1.test)("runtime store loads legacy snake_case thread metadata and history items", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-store-legacy-"));
    try {
        fs.mkdirSync(path.join(baseDir, "threads"), { recursive: true });
        fs.writeFileSync(path.join(baseDir, "index.json"), JSON.stringify({
            version: 1,
            threads: {
                "claude:legacy-thread": {
                    id: "claude:legacy-thread",
                    provider: "claude",
                    provider_session_id: "session-legacy",
                    title: "Legacy Claude thread",
                    first_prompt: "Initial prompt",
                    cwd: "/tmp/legacy-project",
                    created_at: "2026-03-10T00:00:00.000Z",
                    updated_at: "2026-03-11T00:00:00.000Z",
                    archived: false,
                },
            },
            providerSessions: {},
        }, null, 2));
        fs.writeFileSync(path.join(baseDir, "threads", "claude:legacy-thread.json"), JSON.stringify({
            thread_id: "claude:legacy-thread",
            turns: [
                {
                    turn_id: "turn-legacy",
                    created_at: "2026-03-11T01:00:00.000Z",
                    status: "completed",
                    items: [
                        {
                            item_id: "item-legacy",
                            type: "agent_message",
                            role: "assistant",
                            text: "legacy hello",
                            content: [{ type: "text", text: "legacy hello" }],
                            explanation: "keep me",
                            file_changes: [{ path: "README.md" }],
                        },
                    ],
                },
            ],
        }, null, 2));
        const store = (0, runtime_store_1.createRuntimeStore)({ baseDir });
        try {
            const thread = store.getThreadMeta("claude:legacy-thread");
            node_assert_1.strict.equal(thread?.providerSessionId, "session-legacy");
            node_assert_1.strict.equal(thread?.preview, "Initial prompt");
            node_assert_1.strict.equal(store.findThreadIdByProviderSession("claude", "session-legacy"), "claude:legacy-thread");
            const history = store.getThreadHistory("claude:legacy-thread");
            node_assert_1.strict.equal(history?.threadId, "claude:legacy-thread");
            node_assert_1.strict.equal(history?.turns?.[0]?.id, "turn-legacy");
            node_assert_1.strict.equal(history?.turns?.[0]?.items?.[0]?.id, "item-legacy");
            node_assert_1.strict.equal(history?.turns?.[0]?.items?.[0]?.text, "legacy hello");
            node_assert_1.strict.equal(history?.turns?.[0]?.items?.[0]?.explanation, "keep me");
            node_assert_1.strict.deepEqual(history?.turns?.[0]?.items?.[0]?.fileChanges, [{ path: "README.md" }]);
        }
        finally {
            store.shutdown();
        }
    }
    finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});
