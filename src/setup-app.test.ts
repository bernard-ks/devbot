import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appPath = fileURLToPath(new URL("./setup-app.js", import.meta.url));

interface SetupServer {
  child: ChildProcess;
  baseUrl: string;
  cwd: string;
  stderr: () => string;
}

async function startSetupServer(options: {
  studioEnabled?: boolean;
  envStudioEnabled?: boolean;
  codexStatus?: "missing" | "signed-out" | "ready";
  discordStatus?: "ready" | "internal-error" | "guild-refresh-error";
} = {}): Promise<SetupServer> {
  const cwd = await mkdtemp(path.join(tmpdir(), "devbot-setup-app-"));
  if (typeof options.studioEnabled === "boolean") {
    await mkdir(path.join(cwd, ".devbot"), { recursive: true });
    await writeFile(
      path.join(cwd, ".devbot/setup.json"),
      JSON.stringify({
        version: 1,
        viewerUserIds: [],
        controllerUserIds: [],
        peerBotIds: [],
        repositories: {},
        projectRoomIds: {},
        studioEnabled: options.studioEnabled
      })
    );
  }
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  if (typeof options.envStudioEnabled === "boolean") {
    env.DEVBOT_STUDIO_ENABLED = options.envStudioEnabled ? "true" : "false";
  } else {
    delete env.DEVBOT_STUDIO_ENABLED;
  }
  env.DEVBOT_SETUP_NO_BROWSER = "true";
  env.DEVBOT_SETUP_NO_START = "true";
  env.DEVBOT_STATE_DIR = path.join(cwd, ".state");
  if (options.codexStatus && options.codexStatus !== "missing") {
    const fakeCodex = path.join(cwd, "fake-codex");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'if (process.argv[2] === "--version") { console.log("codex-cli test"); process.exit(0); }',
        `if (process.argv[2] === "login" && process.argv[3] === "status") { process.exit(${options.codexStatus === "ready" ? 0 : 1}); }`,
        "process.exit(1);",
        ""
      ].join("\n")
    );
    await chmod(fakeCodex, 0o755);
    env.CODEX_BIN = fakeCodex;
  } else {
    env.CODEX_BIN = path.join(cwd, "missing-codex");
  }
  const nodeArgs: string[] = [];
  if (options.discordStatus) {
    const fakeDiscord = path.join(cwd, "fake-discord.mjs");
    const fetchImplementation = options.discordStatus !== "internal-error"
      ? [
          "let guildRequests = 0;",
          "globalThis.fetch = async (input) => {",
          "  const pathname = new URL(String(input)).pathname;",
          "  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });",
          "  if (pathname === '/api/v10/users/@me') return json({ id: 'bot-1', username: 'Testbot', bot: true });",
          "  if (pathname === '/api/v10/oauth2/applications/@me') return json({ id: 'app-1' });",
          "  if (pathname === '/api/v10/users/@me/guilds') {",
          "    guildRequests += 1;",
          ...(options.discordStatus === "guild-refresh-error"
            ? ["    if (guildRequests > 1) throw new Error('private guild refresh diagnostic at /Users/operator/private/guilds.json');"]
            : []),
          "    return json([{ id: 'guild-1', name: 'Test guild' }]);",
          "  }",
          "  if (pathname === '/api/v10/guilds/guild-1') return json({ id: 'guild-1', name: 'Test guild', owner_id: 'owner-1' });",
          "  return json({ message: 'Unexpected fake Discord route' }, 500);",
          "};",
          ""
        ]
      : [
          "globalThis.fetch = async () => {",
          "  throw new Error(\"private diagnostic at /Users/operator/private/setup-secrets.json\");",
          "};",
          ""
        ];
    await writeFile(fakeDiscord, fetchImplementation.join("\n"));
    nodeArgs.push("--import", fakeDiscord);
  }
  const child = spawn(process.execPath, [...nodeArgs, appPath], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Setup app did not report a URL. Output: ${output}`)), 30_000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Setup app exited early with code ${code}. Output: ${output}`));
    });
  });
  return { child, baseUrl, cwd, stderr: () => stderr };
}

async function stopSetupServer(server: SetupServer): Promise<void> {
  const exited = new Promise<void>((resolve) => server.child.once("exit", () => resolve()));
  server.child.kill("SIGTERM");
  await exited;
}

async function waitForStderr(server: SetupServer, pattern: RegExp): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = server.stderr();
    if (pattern.test(output)) return output;
    await delay(20);
  }
  throw new Error(`Setup app did not log ${pattern}. Stderr: ${server.stderr()}`);
}

test("setup API is bound to the claiming browser session", async (t) => {
  const server = await startSetupServer();
  t.after(async () => {
    await stopSetupServer(server);
  });
  const { baseUrl } = server;
  let claimCookie = "";

  await t.test("first browser claims the page and receives an HttpOnly session cookie", async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^devbot_setup=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/);
    claimCookie = setCookie.split(";")[0]!;
    const html = await response.text();
    assert.match(html, /id="choose-folder"/);
    assert.match(html, /id="enable-studio"/);
    assert.doesNotMatch(html, /X-Devbot-Setup/i);
    assert.doesNotMatch(html, /sessionToken/);
  });

  await t.test("the claiming session can call the API", async () => {
    const response = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: claimCookie } });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { node?: { ready?: boolean }; studioEnabled?: boolean };
    assert.equal(typeof payload.node?.ready, "boolean");
    assert.equal(typeof payload.studioEnabled, "boolean");
  });

  await t.test("a second client cannot re-claim the page", async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  });

  await t.test("a second cookie jar cannot call any setup API", async () => {
    const attempts: Array<{ route: string; method: string }> = [
      { route: "/api/state", method: "GET" },
      { route: "/api/connect", method: "POST" },
      { route: "/api/pick-folder", method: "POST" },
      { route: "/api/finish", method: "POST" }
    ];
    for (const jar of [undefined, "devbot_setup=forged-claim-value-000000000000"]) {
      for (const attempt of attempts) {
        const response = await fetch(`${baseUrl}${attempt.route}`, {
          method: attempt.method,
          headers: {
            "Content-Type": "application/json",
            ...(jar ? { Cookie: jar } : {})
          },
          ...(attempt.method === "POST" ? { body: "{}" } : {})
        });
        assert.equal(response.status, 404, `${attempt.method} ${attempt.route} with jar ${jar ?? "empty"}`);
      }
    }
  });

  await t.test("the claiming session still works after rejected clients", async () => {
    const page = await fetch(`${baseUrl}/`, { headers: { Cookie: claimCookie } });
    assert.equal(page.status, 200);
    const api = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: claimCookie } });
    assert.equal(api.status, 200);
  });
});

test("setup API reports the persisted Studio choice before the environment fallback", async (t) => {
  const server = await startSetupServer({ studioEnabled: false, envStudioEnabled: true });
  t.after(async () => {
    await stopSetupServer(server);
  });
  const page = await fetch(`${server.baseUrl}/`);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const response = await fetch(`${server.baseUrl}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { studioEnabled?: boolean };
  assert.equal(payload.studioEnabled, false);
});

test("setup API requires a signed-in Codex session, not only an installed CLI", { skip: process.platform === "win32" }, async (t) => {
  const signedOut = await startSetupServer({ codexStatus: "signed-out" });
  t.after(async () => {
    await stopSetupServer(signedOut);
  });
  const signedOutPage = await fetch(`${signedOut.baseUrl}/`);
  const signedOutCookie = (signedOutPage.headers.get("set-cookie") ?? "").split(";")[0]!;
  const signedOutState = await fetch(`${signedOut.baseUrl}/api/state`, { headers: { Cookie: signedOutCookie } });
  const signedOutPayload = (await signedOutState.json()) as { codex: { ready: boolean; label: string } };
  assert.equal(signedOutPayload.codex.ready, false);
  assert.match(signedOutPayload.codex.label, /sign in/i);

  const ready = await startSetupServer({ codexStatus: "ready" });
  t.after(async () => {
    await stopSetupServer(ready);
  });
  const readyPage = await fetch(`${ready.baseUrl}/`);
  const readyCookie = (readyPage.headers.get("set-cookie") ?? "").split(";")[0]!;
  const readyState = await fetch(`${ready.baseUrl}/api/state`, { headers: { Cookie: readyCookie } });
  const readyPayload = (await readyState.json()) as { codex: { ready: boolean; label: string } };
  assert.equal(readyPayload.codex.ready, true);
  assert.match(readyPayload.codex.label, /signed in/i);
});

test("setup API returns actionable client errors with 4xx statuses", async (t) => {
  const server = await startSetupServer();
  t.after(async () => {
    await stopSetupServer(server);
  });
  const page = await fetch(`${server.baseUrl}/`);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;

  const invalidJson = await fetch(`${server.baseUrl}/api/connect`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: "Setup request is not valid JSON." });

  const missingToken = await fetch(`${server.baseUrl}/api/connect`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(missingToken.status, 400);
  assert.deepEqual(await missingToken.json(), { error: "Paste the bot token from the Discord Developer Portal." });

  const missingSession = await fetch(`${server.baseUrl}/api/guilds`, { headers: { Cookie: cookie } });
  assert.equal(missingSession.status, 409);
  assert.deepEqual(await missingSession.json(), { error: "Connect and validate the Discord application first." });
});

test("setup API keeps arbitrary upstream diagnostics out of client responses", async (t) => {
  const server = await startSetupServer({ discordStatus: "internal-error" });
  t.after(async () => {
    await stopSetupServer(server);
  });
  const page = await fetch(`${server.baseUrl}/`);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;

  const response = await fetch(`${server.baseUrl}/api/connect`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-token" })
  });
  const responseText = await response.text();
  assert.equal(response.status, 502);
  assert.equal(
    responseText,
    JSON.stringify({ error: "Discord could not be reached to complete setup. Check your connection and try again." })
  );
  assert.doesNotMatch(responseText, /private diagnostic|\/Users\/operator|setup-secrets/);

  const stderr = await waitForStderr(server, /Setup request failed \(POST \/api\/connect, HTTP 502\)/);
  assert.match(stderr, /private diagnostic/);
  assert.match(stderr, /\[local path\]/);
  assert.doesNotMatch(stderr, /\/Users\/operator|setup-secrets\.json/);
});

test("setup guild refresh maps Discord failures without exposing diagnostics", async (t) => {
  const server = await startSetupServer({ discordStatus: "guild-refresh-error" });
  t.after(async () => {
    await stopSetupServer(server);
  });
  const page = await fetch(`${server.baseUrl}/`);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const connect = await fetch(`${server.baseUrl}/api/connect`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-token" })
  });
  assert.equal(connect.status, 200);

  const response = await fetch(`${server.baseUrl}/api/guilds`, { headers: { Cookie: cookie } });
  const responseText = await response.text();
  assert.equal(response.status, 502);
  assert.equal(
    responseText,
    JSON.stringify({ error: "Discord could not be reached to complete setup. Check your connection and try again." })
  );
  assert.doesNotMatch(responseText, /private guild refresh|\/Users\/operator|guilds\.json/);

  const stderr = await waitForStderr(server, /Setup request failed \(GET \/api\/guilds, HTTP 502\)/);
  assert.match(stderr, /private guild refresh diagnostic/);
  assert.match(stderr, /\[local path\]/);
  assert.doesNotMatch(stderr, /\/Users\/operator|guilds\.json/);
});

test("setup API returns a generic 500 while logging sanitized filesystem diagnostics", async (t) => {
  const server = await startSetupServer({ codexStatus: "ready", discordStatus: "ready" });
  t.after(async () => {
    await stopSetupServer(server);
  });
  const repositoryPath = path.join(server.cwd, "private-repository-do-not-expose");
  await mkdir(repositoryPath);
  await writeFile(path.join(repositoryPath, ".devbot"), "blocks the setup metadata directory");

  const page = await fetch(`${server.baseUrl}/`);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const connect = await fetch(`${server.baseUrl}/api/connect`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-token" })
  });
  assert.equal(connect.status, 200);

  const response = await fetch(`${server.baseUrl}/api/finish`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      guildId: "guild-1",
      repositoryName: "private-repository",
      repositoryPath,
      screenshotPolicy: "approval",
      confirmGuildOwner: true
    })
  });
  const responseText = await response.text();
  assert.equal(response.status, 500);
  assert.equal(
    responseText,
    JSON.stringify({
      error: "Setup could not complete the request. Review the setup terminal for details and try again."
    })
  );
  assert.doesNotMatch(responseText, /EEXIST|private-repository-do-not-expose|\.devbot|repositoryPath/);

  const stderr = await waitForStderr(server, /Setup request failed \(POST \/api\/finish, HTTP 500\)/);
  assert.match(stderr, /EEXIST/);
  assert.match(stderr, /\[local path\]/);
  assert.doesNotMatch(stderr, /private-repository-do-not-expose|\.devbot/);
});
