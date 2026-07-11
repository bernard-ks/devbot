import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { captureProjectScreenshot } from "./project-screenshot.js";
import type { ProjectEntry } from "./types.js";

function project(frontendUrl: string): ProjectEntry {
  return {
    name: "screenshot-redirect-e2e",
    root: process.cwd(),
    metadata: {
      canonicalName: undefined,
      repoUrl: undefined,
      defaultBranch: "main",
      frontendUrl,
      backendUrl: undefined,
      ownerBot: undefined,
      aliases: [],
      commands: { test: [], build: [], lint: [], verify: [], presets: {} },
      policy: {
        visibility: "private",
        allowedUsers: [],
        allowedUsernames: [],
        allowedRoles: [],
        allowedPeers: [],
        screenshotPolicy: "allow",
        maxContextChars: undefined,
        readOnlyCommands: [],
        approvalRequiredCommands: []
      }
    }
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("project screenshots block off-origin redirects while preserving same-origin redirects", async () => {
  const offOriginRequests: string[] = [];
  const offOrigin = http.createServer((request, response) => {
    offOriginRequests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  });
  const offOriginPort = await listen(offOrigin);

  let sameOriginAssetRequests = 0;
  const approved = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/bounce-off") {
      response.writeHead(302, { location: `http://127.0.0.1:${offOriginPort}/pixel.svg` });
      response.end();
      return;
    }
    if (url.pathname === "/bounce-same") {
      response.writeHead(302, { location: "/same.svg" });
      response.end();
      return;
    }
    if (url.pathname === "/same.svg") {
      sameOriginAssetRequests += 1;
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><html><body><h1>Approved page</h1><img src="/bounce-off"><img src="/bounce-same"></body></html>');
  });
  const approvedPort = await listen(approved);

  try {
    const screenshot = await captureProjectScreenshot(project(`http://127.0.0.1:${approvedPort}`));
    assert.ok(screenshot, "the approved page should still render");
    assert.deepEqual(offOriginRequests, [], "a redirect must not escape the approved origin");
    assert.ok(sameOriginAssetRequests > 0, "same-origin redirects should continue to work");
  } finally {
    await Promise.all([close(approved), close(offOrigin)]);
  }
});
