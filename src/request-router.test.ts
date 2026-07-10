import assert from "node:assert/strict";
import test from "node:test";
import {
  contextLimitForRoute,
  fallbackRoute,
  parseRouterResponse,
  routeRequest,
  type RouteRequestInput
} from "./request-router.js";

test("router parses strict JSON even when fenced", () => {
  const route = parseRouterResponse('```json\n{"tier":"deep","context":"full","reason":"Architecture review"}\n```');
  assert.deepEqual(route, { tier: "deep", contextMode: "full", reason: "Architecture review" });
});

test("routing model maps Luna Terra and Sol tiers", async () => {
  const routes = await Promise.all([
    routeRequest(input("Explain a reverse proxy"), async () => '{"tier":"fast","context":"none","reason":"General question"}'),
    routeRequest(input("inspect this handler"), async () => '{"tier":"standard","context":"focused","reason":"Targeted"}'),
    routeRequest(input("review the architecture"), async () => '{"tier":"deep","context":"full","reason":"Broad"}')
  ]);

  assert.deepEqual(routes.map((route) => [route.tier, route.model, route.contextMode]), [
    ["fast", "gpt-5.6-luna", "none"],
    ["standard", "gpt-5.6-terra", "focused"],
    ["deep", "gpt-5.6-sol", "full"]
  ]);
  assert.equal(routes.every((route) => route.source === "model"), true);
});

test("router cannot downgrade actions below Terra with focused context", async () => {
  const route = await routeRequest(
    { ...input("change the button"), mode: "action" },
    async () => '{"tier":"fast","context":"none","reason":"User requested fast"}'
  );
  assert.equal(route.tier, "standard");
  assert.equal(route.model, "gpt-5.6-terra");
  assert.equal(route.contextMode, "focused");
});

test("router failure falls back safely and bare test needs no project context", async () => {
  const route = await routeRequest(input("test"), async () => {
    throw new Error("offline");
  });
  assert.equal(route.source, "fallback");
  assert.equal(route.tier, "fast");
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.contextMode, "none");
});

test("context budgets honor route project and request limits", () => {
  assert.equal(contextLimitForRoute({ contextMode: "none" }, 120_000, 24_000), 0);
  assert.equal(contextLimitForRoute({ contextMode: "focused" }, 120_000, 24_000), 24_000);
  assert.equal(contextLimitForRoute({ contextMode: "full" }, 120_000, 24_000, 80_000, 30_000), 30_000);
});

test("deterministic fallback sends broad analysis to Sol", () => {
  assert.deepEqual(fallbackRoute("Audit the security architecture", "answer"), {
    tier: "deep",
    contextMode: "full",
    reason: "Broad reasoning request that benefits from wider project evidence."
  });
});

function input(text: string): RouteRequestInput {
  return {
    codex: {
      bin: "codex",
      model: "gpt-5.6-sol",
      sandbox: "read-only",
      actionSandbox: "workspace-write",
      timeoutMs: 180_000
    },
    routing: {
      enabled: true,
      routerModel: "gpt-5.6-luna",
      routerReasoningEffort: "low",
      routerTimeoutMs: 30_000,
      fastModel: "gpt-5.6-luna",
      fastReasoningEffort: "low",
      standardModel: "gpt-5.6-terra",
      standardReasoningEffort: "medium",
      deepModel: "gpt-5.6-sol",
      deepReasoningEffort: "ultra",
      focusedContextChars: 24_000
    },
    text,
    mode: "answer",
    projectName: "webapp",
    projectRoot: "/tmp/webapp",
    hasExplicitIncludes: false
  };
}
