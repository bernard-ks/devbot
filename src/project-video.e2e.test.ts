import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { projectScreenshotOrigins } from "./project-screenshot.js";
import { confineRecordingContext, recordProjectFlow } from "./project-video.js";
import type { ProjectEntry } from "./types.js";

function project(frontendUrl: string | undefined): ProjectEntry {
  return {
    name: "clip-e2e",
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

interface OffOriginLog {
  requests: string[];
  upgrades: number;
}

function startOffOriginServer(): Promise<{ server: http.Server; port: number; log: OffOriginLog }> {
  const log: OffOriginLog = { requests: [], upgrades: 0 };
  const server = http.createServer((request, response) => {
    log.requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("off-origin");
  });
  server.on("upgrade", (request, socket) => {
    log.upgrades += 1;
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, log });
    });
  });
}

interface ApprovedLog {
  mutations: number;
}

function startApprovedServer(offOriginPort: number): Promise<{ server: http.Server; port: number; log: ApprovedLog }> {
  const log: ApprovedLog = { mutations: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/mutate") {
      log.mutations += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("mutated");
      return;
    }
    if (url.pathname === "/bounce") {
      response.writeHead(302, { location: `http://127.0.0.1:${offOriginPort}/landing.png` });
      response.end();
      return;
    }
    if (url.pathname === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("self.addEventListener('fetch', () => {});");
      return;
    }
    if (url.pathname === "/detail") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><body><h1>Detail dashboard</h1></body></html>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><body>
      <a href="/detail?token=supersecret#section">Open detail dashboard</a>
      <a target="_blank" href="http://127.0.0.1:${offOriginPort}/external">external popup window</a>
      <img src="http://127.0.0.1:${offOriginPort}/pixel.png" alt="">
      <img src="/bounce" alt="">
      <button onclick="fetch('/mutate',{method:'POST'})">Delete account permanently</button>
      <form action="/mutate" method="post"><input type="submit" value="Submit order now"></form>
      <script>try { new WebSocket("ws://127.0.0.1:${offOriginPort}/ws"); } catch {}</script>
    </body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, log });
    });
  });
}

function startHangingServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((request, response) => {
    if (request.url === "/hang") {
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><html><body><img src="/hang" alt=""></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

test("recorded flows stay origin-confined and cannot trigger mutating controls", async () => {
  const offOrigin = await startOffOriginServer();
  const approved = await startApprovedServer(offOrigin.port);
  try {
    const entry = project(`http://127.0.0.1:${approved.port}`);
    const outcome = await recordProjectFlow(
      entry,
      "click the external popup window, then click delete account, then submit order now, then open detail dashboard"
    );

    assert.equal(outcome.kind, "video");
    if (outcome.kind !== "video") {
      return;
    }
    assert.equal(outcome.metadata.finalUrl, `http://127.0.0.1:${approved.port}/detail`);
    assert.doesNotMatch(outcome.metadata.finalUrl, /supersecret|[?#]/);
    assert.ok(!outcome.metadata.stepsPerformed.some((step) => /delete account|submit order/i.test(step)));
    assert.ok(outcome.metadata.stepsPerformed.some((step) => /detail dashboard/i.test(step)));

    assert.deepEqual(offOrigin.log.requests, []);
    assert.equal(offOrigin.log.upgrades, 0);
    assert.equal(approved.log.mutations, 0);
  } finally {
    approved.server.closeAllConnections();
    offOrigin.server.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => approved.server.close(resolve)),
      new Promise((resolve) => offOrigin.server.close(resolve))
    ]);
  }
});

test("confined contexts close popups, block off-origin sockets, and block service workers", async () => {
  const offOrigin = await startOffOriginServer();
  const approved = await startApprovedServer(offOrigin.port);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const entry = project(`http://127.0.0.1:${approved.port}`);
    const allowedOrigins = projectScreenshotOrigins(entry, [`http://127.0.0.1:${approved.port}`]);
    const context = await browser.newContext({ serviceWorkers: "block" });
    await confineRecordingContext(context, allowedOrigins);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${approved.port}/`, { waitUntil: "load" });

    await page.locator("a[target='_blank']").click();
    await page.waitForTimeout(1_000);
    assert.equal(context.pages().length, 1);
    assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${approved.port}`);

    const socketResult = await page.evaluate(
      (wsUrl) =>
        new Promise((resolve) => {
          const socket = new WebSocket(wsUrl);
          socket.onopen = () => resolve("open");
          socket.onclose = () => resolve("closed");
          setTimeout(() => resolve("timeout"), 3_000);
        }),
      `ws://127.0.0.1:${offOrigin.port}/ws`
    );
    assert.equal(socketResult, "closed");

    const workerResult = await page.evaluate(() => {
      const workers = (navigator as unknown as {
        serviceWorker?: { register(url: string): Promise<unknown>; ready: Promise<unknown> };
      }).serviceWorker;
      if (!workers) {
        return Promise.resolve("blocked");
      }
      return Promise.race([
        workers.register("/sw.js").then(() => workers.ready).then(() => "active", () => "blocked"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 2_000))
      ]);
    });
    assert.equal(workerResult, "blocked");

    assert.deepEqual(offOrigin.log.requests, []);
    assert.equal(offOrigin.log.upgrades, 0);
  } finally {
    await browser.close();
    approved.server.closeAllConnections();
    offOrigin.server.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => approved.server.close(resolve)),
      new Promise((resolve) => offOrigin.server.close(resolve))
    ]);
  }
});

test("recording aborts at the hard deadline instead of trusting cooperative checks", async () => {
  const hanging = await startHangingServer();
  try {
    const entry = project(`http://127.0.0.1:${hanging.port}`);
    const startedAt = Date.now();
    const outcome = await recordProjectFlow(entry, "look at the page", { hardTimeoutMs: 5_000 });
    const elapsed = Date.now() - startedAt;

    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind === "unavailable") {
      assert.match(outcome.reason, /time budget/i);
    }
    assert.ok(elapsed < 20_000, `hard deadline should cut a hanging page load well before goto's own timeout (took ${elapsed}ms)`);
  } finally {
    hanging.server.closeAllConnections();
    await new Promise((resolve) => hanging.server.close(resolve));
  }
});

test("concurrent recordings beyond the limit are refused and the slot is released", async () => {
  const hanging = await startHangingServer();
  try {
    const first = recordProjectFlow(project(`http://127.0.0.1:${hanging.port}`), "look", { hardTimeoutMs: 5_000 });
    const second = await recordProjectFlow(project(`http://127.0.0.1:${hanging.port}`), "look", { hardTimeoutMs: 5_000 });
    assert.equal(second.kind, "unavailable");
    if (second.kind === "unavailable") {
      assert.match(second.reason, /recording limit/i);
    }
    await first;

    const third = await recordProjectFlow(project(undefined), "look", {});
    assert.equal(third.kind, "unavailable");
    if (third.kind === "unavailable") {
      assert.match(third.reason, /No running local web UI/i);
    }
  } finally {
    hanging.server.closeAllConnections();
    await new Promise((resolve) => hanging.server.close(resolve));
  }
});
