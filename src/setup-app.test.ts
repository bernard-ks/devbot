import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appPath = fileURLToPath(new URL("./setup-app.js", import.meta.url));

interface SetupServer {
  child: ChildProcess;
  baseUrl: string;
}

async function startSetupServer(): Promise<SetupServer> {
  const cwd = await mkdtemp(path.join(tmpdir(), "devbot-setup-app-"));
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  env.DEVBOT_SETUP_NO_BROWSER = "true";
  env.DEVBOT_SETUP_NO_START = "true";
  env.CODEX_BIN = path.join(cwd, "missing-codex");
  const child = spawn(process.execPath, [appPath], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  return { child, baseUrl };
}

async function stopSetupServer(server: SetupServer): Promise<void> {
  const exited = new Promise<void>((resolve) => server.child.once("exit", () => resolve()));
  server.child.kill("SIGTERM");
  await exited;
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
    assert.doesNotMatch(html, /X-Devbot-Setup/i);
    assert.doesNotMatch(html, /sessionToken/);
  });

  await t.test("the claiming session can call the API", async () => {
    const response = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: claimCookie } });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { node?: { ready?: boolean } };
    assert.equal(typeof payload.node?.ready, "boolean");
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
