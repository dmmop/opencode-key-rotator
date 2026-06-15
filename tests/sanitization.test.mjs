import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMessage, sanitizeRateLimitHeaders } from "../dist/rotation-log.js";

test("sanitizeMessage redacts Bearer tokens", () => {
  const message = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  assert.equal(sanitizeMessage(message), "Authorization: Bearer [redacted]");
});

test("sanitizeMessage redacts api_key", () => {
  const message = "request failed api_key=sk-1234567890abcdef";
  assert.equal(sanitizeMessage(message), "request failed api_key=[redacted]");
});

test("sanitizeMessage redacts access_token", () => {
  const message = "access_token=foo.bar.baz retry";
  assert.equal(sanitizeMessage(message), "access_token=[redacted] retry");
});

test("sanitizeMessage redacts refresh_token", () => {
  const message = "refresh_token=secret-token-value";
  assert.equal(sanitizeMessage(message), "refresh_token=[redacted]");
});

test("sanitizeMessage redacts secret", () => {
  const message = "client_secret=shhh";
  assert.equal(sanitizeMessage(message), "client_secret=[redacted]");
});

test("sanitizeMessage truncates to 500 characters", () => {
  const message = "x".repeat(1000);
  assert.equal(sanitizeMessage(message)?.length, 500);
});

test("sanitizeMessage returns undefined for empty input", () => {
  assert.equal(sanitizeMessage(""), undefined);
  assert.equal(sanitizeMessage(undefined), undefined);
});

test("sanitizeRateLimitHeaders keeps retry-after and x-ratelimit headers", () => {
  const headers = {
    "retry-after": "60",
    "x-ratelimit-remaining": "100",
    "x-ratelimit-reset": "1234567890",
    authorization: "Bearer secret",
    "content-type": "application/json",
  };
  const result = sanitizeRateLimitHeaders(headers);
  assert.equal(result["retry-after"], "60");
  assert.equal(result["x-ratelimit-remaining"], "100");
  assert.equal(result["x-ratelimit-reset"], "1234567890");
  assert.equal(result.authorization, undefined);
  assert.equal(result["content-type"], undefined);
});

test("sanitizeRateLimitHeaders lowercases keys", () => {
  const headers = {
    "Retry-After": "60",
    "X-RateLimit-Remaining": "100",
  };
  const result = sanitizeRateLimitHeaders(headers);
  assert.equal(result["retry-after"], "60");
  assert.equal(result["x-ratelimit-remaining"], "100");
  assert.equal(result["Retry-After"], undefined);
});

test("sanitizeRateLimitHeaders truncates values to 120 characters", () => {
  const headers = { "retry-after": "x".repeat(200) };
  const result = sanitizeRateLimitHeaders(headers);
  assert.equal(result["retry-after"].length, 120);
});

test("sanitizeRateLimitHeaders returns undefined when no relevant headers", () => {
  const headers = { "content-type": "application/json" };
  assert.equal(sanitizeRateLimitHeaders(headers), undefined);
});

test("sanitizeRateLimitHeaders returns undefined for non-object input", () => {
  assert.equal(sanitizeRateLimitHeaders(undefined), undefined);
  assert.equal(sanitizeRateLimitHeaders("string"), undefined);
});
