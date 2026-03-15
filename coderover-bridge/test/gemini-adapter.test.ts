// @ts-nocheck
export {};

// FILE: gemini-adapter.test.js
// Purpose: Verifies Gemini CLI history import normalizes local chat JSON into bridge timeline messages.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/providers/gemini-adapter

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractGeminiMessages,
  normalizeGeminiMessage,
} = require("../src/providers/gemini-adapter");

test("normalizeGeminiMessage supports real Gemini user and assistant entries", () => {
  assert.deepEqual(
    normalizeGeminiMessage({
      type: "user",
      content: [
        { text: "first line" },
        { text: "second line" },
      ],
    }),
    {
      role: "user",
      text: "first line\nsecond line",
    }
  );

  assert.deepEqual(
    normalizeGeminiMessage({
      type: "gemini",
      content: "assistant reply",
    }),
    {
      role: "assistant",
      text: "assistant reply",
    }
  );
});

test("extractGeminiMessages ignores info entries and keeps local chat history", () => {
  const messages = extractGeminiMessages({
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
