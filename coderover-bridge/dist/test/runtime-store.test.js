"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// FILE: runtime-store.test.js
// Purpose: Verifies provider-aware overlay persistence for managed runtime threads.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/runtime-store
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRuntimeStore } = require("../src/runtime-store");
function createTempStore() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "coderover-runtime-store-"));
    const store = createRuntimeStore({ baseDir });
    return {
        store,
        cleanup() {
            store.shutdown();
            fs.rmSync(baseDir, { recursive: true, force: true });
        },
    };
}
test("runtime store persists provider session mappings and thread history", () => {
    const fixture = createTempStore();
    try {
        const created = fixture.store.createThread({
            provider: "claude",
            providerSessionId: "session-1",
            title: "Claude thread",
            cwd: "/tmp/project-a",
        });
        assert.match(created.id, /^claude:/);
        assert.equal(fixture.store.findThreadIdByProviderSession("claude", "session-1"), created.id);
        fixture.store.bindProviderSession(created.id, "claude", "session-2");
        assert.equal(fixture.store.findThreadIdByProviderSession("claude", "session-1"), null);
        assert.equal(fixture.store.findThreadIdByProviderSession("claude", "session-2"), created.id);
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
        assert.equal(history?.turns?.length, 1);
        assert.equal(history?.turns?.[0]?.items?.[0]?.text, "hello");
    }
    finally {
        fixture.cleanup();
    }
});
test("runtime store keeps archive and name overlays in the thread index", () => {
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
        assert.equal(updated?.name, "Renamed Gemini thread");
        assert.equal(updated?.archived, true);
        fixture.store.deleteThread(created.id);
        assert.equal(fixture.store.getThreadMeta(created.id), null);
        assert.equal(fixture.store.findThreadIdByProviderSession("gemini", "chat-1"), null);
    }
    finally {
        fixture.cleanup();
    }
});
