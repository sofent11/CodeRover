"use strict";
// FILE: gemini-adapter.test.ts
// Purpose: Verifies Gemini CLI history import normalizes local chat JSON into bridge timeline messages.
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = require("node:assert");
const gemini_adapter_1 = require("../src/providers/gemini-adapter");
(0, node_test_1.test)("normalizeGeminiMessage supports real Gemini user and assistant entries", () => {
    node_assert_1.strict.deepEqual((0, gemini_adapter_1.normalizeGeminiMessage)({
        type: "user",
        content: [
            { text: "first line" },
            { text: "second line" },
        ],
    }), {
        role: "user",
        text: "first line\nsecond line",
    });
    node_assert_1.strict.deepEqual((0, gemini_adapter_1.normalizeGeminiMessage)({
        type: "gemini",
        content: "assistant reply",
    }), {
        role: "assistant",
        text: "assistant reply",
    });
});
(0, node_test_1.test)("extractGeminiMessages ignores info entries and keeps local chat history", () => {
    const messages = (0, gemini_adapter_1.extractGeminiMessages)({
        sessionId: "session-1",
        messages: [
            {
                type: "user",
                content: [{ text: "review this diff" }],
            },
            {
                type: "gemini",
                content: "I will inspect the changed files.",
            },
            {
                type: "info",
                content: "Request cancelled.",
            },
            {
                type: "user",
                content: [{ text: "continue" }],
            },
            {
                type: "gemini",
                content: "",
                thoughts: [
                    {
                        description: "I am preparing the next step.",
                    },
                ],
            },
        ],
    });
    node_assert_1.strict.deepEqual(messages, [
        {
            role: "user",
            text: "review this diff",
        },
        {
            role: "assistant",
            text: "I will inspect the changed files.",
        },
        {
            role: "user",
            text: "continue",
        },
        {
            role: "assistant",
            text: "I am preparing the next step.",
        },
    ]);
});
