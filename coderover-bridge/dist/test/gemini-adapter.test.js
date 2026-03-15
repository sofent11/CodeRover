"use strict";
// FILE: gemini-adapter.test.ts
// Purpose: Verifies Gemini CLI history import normalizes local chat JSON into bridge timeline messages.
Object.defineProperty(exports, "__esModule", { value: true });
const test = require("node:test");
const assert = require("node:assert/strict");
const gemini_adapter_1 = require("../src/providers/gemini-adapter");
test("normalizeGeminiMessage supports real Gemini user and assistant entries", () => {
    assert.deepEqual((0, gemini_adapter_1.normalizeGeminiMessage)({
        type: "user",
        content: [
            { text: "first line" },
            { text: "second line" },
        ],
    }), {
        role: "user",
        text: "first line\nsecond line",
    });
    assert.deepEqual((0, gemini_adapter_1.normalizeGeminiMessage)({
        type: "gemini",
        content: "assistant reply",
    }), {
        role: "assistant",
        text: "assistant reply",
    });
});
test("extractGeminiMessages ignores info entries and keeps local chat history", () => {
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
    assert.deepEqual(messages, [
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
