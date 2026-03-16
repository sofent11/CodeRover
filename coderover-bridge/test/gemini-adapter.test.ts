// FILE: gemini-adapter.test.ts
// Purpose: Verifies Gemini CLI history import normalizes local chat JSON into bridge timeline messages.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  extractGeminiMessages,
  normalizeGeminiMessage,
} from "../src/providers/gemini-adapter";

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
      createdAt: null,
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
      createdAt: null,
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
      createdAt: null,
    },
    {
      role: "assistant",
      text: "I will inspect the changed files.",
      createdAt: null,
    },
    {
      role: "user",
      text: "continue",
      createdAt: null,
    },
    {
      role: "assistant",
      text: "I am preparing the next step.",
      createdAt: null,
    },
  ]);
});

test("extractGeminiMessages sorts by createdAt when present", () => {
  const messages = extractGeminiMessages({
    messages: [
      {
        type: "user",
        content: "second",
        createdAt: "2026-03-16T10:00:02.000Z",
      },
      {
        type: "user",
        content: "first",
        createdAt: "2026-03-16T10:00:01.000Z",
      },
    ],
  });

  assert.equal(messages[0].text, "first");
  assert.equal(messages[1].text, "second");
});
