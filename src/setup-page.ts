export function renderSetupPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Devbot Setup</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --ink: #f4f6f8;
      --muted: #9ba4b0;
      --line: #2c323b;
      --surface: #171a20;
      --surface-raised: #1d2128;
      --field: #101318;
      --canvas: #0d0f13;
      --discord: #7480ff;
      --discord-dark: #616de8;
      --green: #71d6a1;
      --green-soft: #14271e;
      --amber: #f3c56f;
      --amber-soft: #302611;
      --coral: #ff7d6d;
      --coral-soft: #321b1d;
      --shadow: 0 24px 58px rgba(0, 0, 0, 0.32);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: var(--canvas); color: var(--ink); }
    button, input, select { font: inherit; letter-spacing: 0; }
    button, .button { min-height: 42px; border-radius: 6px; border: 1px solid transparent; padding: 0 16px; font-weight: 650; cursor: pointer; transition: background 140ms ease, border-color 140ms ease, transform 140ms ease; }
    button:hover, .button:hover { transform: translateY(-1px); }
    button:disabled { cursor: not-allowed; opacity: 0.48; transform: none; }
    .button { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
    .primary { color: white; background: var(--discord); }
    .primary:hover { background: var(--discord-dark); }
    .secondary { color: var(--ink); background: var(--surface-raised); border-color: #3a424d; }
    .secondary:hover { border-color: #566171; background: #242932; }
    .quiet { color: var(--muted); background: transparent; border-color: var(--line); }
    .topbar { height: 68px; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; border-bottom: 1px solid var(--line); background: rgba(15,18,23,0.96); }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 7px; background: var(--discord); color: white; font: 700 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace; box-shadow: 0 0 0 1px rgba(255,255,255,0.08) inset; }
    .brand-copy strong { display: block; font-size: 16px; }
    .brand-copy span { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    .local-pill { display: inline-flex; align-items: center; gap: 7px; border: 1px solid #28543e; background: var(--green-soft); color: var(--green); border-radius: 999px; padding: 7px 10px; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .local-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
    .shell { width: min(1120px, calc(100% - 40px)); margin: 32px auto 56px; display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 26px; }
    .rail { padding: 8px 0; align-self: start; position: sticky; top: 24px; }
    .rail h1 { margin: 0 0 8px; font-size: 25px; line-height: 1.15; letter-spacing: 0; }
    .rail > p { margin: 0 0 26px; color: var(--muted); font-size: 14px; line-height: 1.55; }
    .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .step { display: grid; grid-template-columns: 28px 1fr; align-items: center; gap: 10px; padding: 10px 8px; color: var(--muted); font-size: 14px; font-weight: 650; }
    .step-number { width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid #3a424d; border-radius: 50%; background: var(--surface); color: var(--muted); font-size: 12px; }
    .step.active { color: var(--ink); }
    .step.active .step-number { background: var(--discord); color: white; border-color: var(--discord); }
    .step.done .step-number { color: var(--green); background: var(--green-soft); border-color: #28543e; }
    .workspace { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; }
    .section { padding: 28px 32px; border-bottom: 1px solid var(--line); }
    .section:last-child { border-bottom: 0; }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
    .section-heading h2 { margin: 0; font-size: 18px; line-height: 1.25; letter-spacing: 0; }
    .section-heading p { margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .status { flex: none; border-radius: 999px; padding: 6px 9px; font-size: 11px; font-weight: 750; text-transform: uppercase; }
    .status.waiting { color: var(--amber); background: var(--amber-soft); }
    .status.ready { color: var(--green); background: var(--green-soft); }
    .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
    .check { padding: 16px; min-width: 0; }
    .check + .check { border-left: 1px solid var(--line); }
    .check span { color: var(--muted); font-size: 12px; }
    .check strong { display: block; margin-top: 5px; font-size: 14px; overflow-wrap: anywhere; }
    .check strong.good { color: var(--green); }
    .check strong.bad { color: var(--coral); }
    .portal-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px; border: 1px solid var(--line); border-radius: 7px; background: #12151a; }
    .portal-row strong { display: block; font-size: 14px; }
    .portal-row p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .optional-badge { display: inline-flex; margin-left: 7px; vertical-align: 2px; border: 1px solid #3a424d; border-radius: 999px; padding: 3px 7px; color: var(--muted); font-size: 9px; font-weight: 780; letter-spacing: 0.04em; text-transform: uppercase; }
    .studio-opt-in { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px; border: 1px solid var(--line); border-radius: 7px; background: #12151a; }
    .studio-opt-in strong { display: block; font-size: 14px; }
    .studio-opt-in p { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .studio-config { display: grid; gap: 16px; }
    .studio-note { padding: 13px 15px; border-left: 3px solid var(--discord); background: rgba(116,128,255,0.1); color: #cbd0ff; font-size: 12px; line-height: 1.5; }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
    .field { min-width: 0; }
    .field.full { grid-column: 1 / -1; }
    label { display: block; margin-bottom: 7px; font-size: 12px; font-weight: 720; color: #c7cdd5; }
    input, select { width: 100%; height: 44px; padding: 0 12px; border: 1px solid #3a424d; border-radius: 6px; color: var(--ink); background: var(--field); outline: none; }
    input::placeholder { color: #697382; }
    input:focus, select:focus { border-color: var(--discord); box-shadow: 0 0 0 3px rgba(116,128,255,0.22); }
    .field-hint { margin: 6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.4; }
    .input-action { display: flex; align-items: center; gap: 8px; }
    .input-action input { flex: 1 1 auto; min-width: 0; }
    .input-action button { flex: none; }
    .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .identity { display: none; align-items: center; gap: 12px; margin-top: 18px; padding: 13px 15px; border: 1px solid #28543e; border-radius: 7px; background: var(--green-soft); }
    .identity.visible { display: flex; }
    .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #262c35; }
    .avatar-fallback { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--discord); color: white; font-weight: 800; }
    .identity strong { display: block; font-size: 14px; }
    .identity span { display: block; color: var(--green); font-size: 12px; margin-top: 3px; }
    .finish-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .finish-copy strong { display: block; font-size: 14px; }
    .finish-copy span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .success { display: none; padding: 44px 32px; }
    .success.visible { display: block; }
    .success-mark { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 50%; background: var(--green-soft); color: var(--green); font-size: 24px; font-weight: 850; }
    .success h2 { margin: 18px 0 8px; font-size: 24px; letter-spacing: 0; }
    .success > p { margin: 0; color: var(--muted); line-height: 1.6; }
    .quickstart { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 26px 0; background: var(--line); border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
    .quickstart div { padding: 16px; background: var(--surface); min-width: 0; }
    .quickstart span { color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 750; }
    .quickstart code { display: block; margin-top: 7px; color: var(--ink); font-size: 12px; overflow-wrap: anywhere; white-space: normal; }
    .error { display: none; margin-top: 14px; border-left: 3px solid var(--coral); background: var(--coral-soft); color: #ffafa4; padding: 11px 13px; font-size: 12px; line-height: 1.5; }
    .error.visible { display: block; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.45); border-top-color: white; border-radius: 50%; animation: spin 700ms linear infinite; vertical-align: -2px; margin-right: 7px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hidden { display: none !important; }
    footer { width: min(1120px, calc(100% - 40px)); margin: -28px auto 30px; color: var(--muted); font-size: 11px; text-align: right; }
    @media (max-width: 760px) {
      .topbar { height: 62px; padding: 0 18px; }
      .brand-copy span { display: none; }
      .shell { width: min(100% - 24px, 680px); margin-top: 18px; grid-template-columns: 1fr; gap: 12px; }
      .rail { position: static; padding: 0; }
      .rail h1, .rail > p { display: none; }
      .steps { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; }
      .step { grid-template-columns: 24px 1fr; gap: 6px; padding: 7px 3px; font-size: 11px; }
      .step-number { width: 22px; height: 22px; font-size: 10px; }
      .section { padding: 22px 18px; }
      .checks, .fields, .quickstart { grid-template-columns: 1fr; }
      .check + .check { border-left: 0; border-top: 1px solid var(--line); }
      .field.full { grid-column: auto; }
      .portal-row, .finish-row, .studio-opt-in { align-items: stretch; flex-direction: column; }
      .input-action { align-items: stretch; flex-direction: column; }
      .portal-row .button, .finish-row button { width: 100%; }
      footer { width: calc(100% - 30px); margin-top: -20px; text-align: center; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="mark">&lt;/&gt;</div>
      <div class="brand-copy"><strong>Devbot setup</strong><span>Local Discord workspace</span></div>
    </div>
    <div class="local-pill">Local only</div>
  </header>

  <main class="shell">
    <aside class="rail">
      <h1>Ready in one pass.</h1>
      <p>Connect Discord, choose a server and repository, then open your private Devbot room.</p>
      <ol class="steps">
        <li class="step active" id="step-system"><span class="step-number">1</span><span>System</span></li>
        <li class="step" id="step-discord"><span class="step-number">2</span><span>Discord</span></li>
        <li class="step" id="step-workspace"><span class="step-number">3</span><span>Workspace</span></li>
      </ol>
    </aside>

    <div class="workspace" id="setup-workspace">
      <section class="section">
        <div class="section-heading">
          <div><h2>System check</h2><p>Devbot runs through the Codex session already on this machine.</p></div>
          <span class="status waiting" id="system-status">Checking</span>
        </div>
        <div class="checks">
          <div class="check"><span>Node.js</span><strong id="node-check">Checking...</strong></div>
          <div class="check"><span>Codex</span><strong id="codex-check">Checking...</strong></div>
        </div>
      </section>

      <section class="section">
        <div class="section-heading">
          <div><h2>Connect Discord</h2><p>Discord requires the application to be created in its Developer Portal. Devbot handles everything after the token.</p></div>
          <span class="status waiting" id="discord-status">Not connected</span>
        </div>

        <div class="portal-row">
          <div><strong>Create the application and copy its bot token</strong><p>Choose New Application, open Bot, then Reset Token. No privileged intent toggle is needed.</p></div>
          <a class="button secondary" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Open Developer Portal</a>
        </div>

        <form id="token-form">
          <div class="fields">
            <div class="field full">
              <label for="token">Bot token</label>
              <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the token once">
              <p class="field-hint">Validated directly with Discord, then written only to this repo's ignored local .env file.</p>
            </div>
          </div>
          <div class="actions">
            <button class="primary" id="connect-button" type="submit">Connect application</button>
          </div>
        </form>

        <div class="identity" id="identity">
          <div id="avatar-wrap"></div>
          <div><strong id="bot-name"></strong><span>Bot token verified</span></div>
        </div>

        <div class="actions hidden" id="install-actions">
          <a class="button primary" id="install-link" target="_blank" rel="noreferrer">Add Devbot to Discord</a>
          <button class="secondary" id="refresh-guilds" type="button">Refresh servers</button>
        </div>
        <div class="error" id="discord-error" role="alert"></div>
      </section>

      <section class="section">
        <div class="section-heading">
          <div><h2>Choose the workspace</h2><p>The selected server owner becomes Devbot's initial owner. The repository remains on this machine.</p></div>
          <span class="status waiting" id="workspace-status">Waiting</span>
        </div>
        <div class="fields">
          <div class="field full">
            <label for="guild">Discord server</label>
            <select id="guild" disabled><option value="">Add the bot to a server first</option></select>
          </div>
          <div class="field">
            <label for="repo-path">Repository path</label>
            <div class="input-action">
              <input id="repo-path" type="text" autocomplete="off" spellcheck="false" placeholder="/Users/me/Projects/my-app">
              <button class="secondary" id="choose-folder" type="button">Choose folder</button>
            </div>
          </div>
          <div class="field">
            <label for="repo-name">Short name</label>
            <input id="repo-name" type="text" autocomplete="off" spellcheck="false" maxlength="40" placeholder="my-app">
          </div>
        </div>
        <div class="error" id="finish-error" role="alert"></div>
      </section>

      <section class="section">
        <div class="section-heading">
          <div><h2>Devbot Studio <span class="optional-badge">Optional</span></h2><p>A richer task board, agent map, branch state, approvals, and proof rendered directly in Discord.</p></div>
          <span class="status waiting" id="studio-status">Skipped</span>
        </div>
        <div class="studio-opt-in" id="studio-opt-in">
          <div><strong>Enable the Discord-native workroom</strong><p>Studio runs inside the bot process on this PC. It creates no public URL, tunnel, Activity, web server, or loopback listener.</p></div>
          <button class="secondary" id="enable-studio" type="button" disabled>Enable Studio</button>
        </div>
        <div class="studio-config hidden" id="studio-config">
          <div class="studio-note"><strong>Private by construction.</strong> \`/studio\` works only for the owner or approved controllers in Devbot's configured private room, and every task is filtered through its current project and requester policy.</div>
          <div class="actions">
            <button class="secondary" id="disable-studio" type="button">Disable Studio</button>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="finish-row">
          <div class="finish-copy"><strong>Finish local setup</strong><span>Creates the private room, deploys commands, saves local config, applies the optional Studio choice, posts the workspace launcher, and starts Devbot.</span></div>
          <button class="primary" id="finish-button" type="button" disabled>Finish setup</button>
        </div>
      </section>
    </div>

    <section class="workspace success" id="success">
      <div class="success-mark">✓</div>
      <h2>Devbot is ready.</h2>
      <p id="success-copy"></p>
      <div class="quickstart">
        <div><span>Open</span><code>Open workspace</code></div>
        <div><span>Explore</span><code id="success-explore">Ask or Status</code></div>
        <div><span>Build</span><code>Make change</code></div>
      </div>
      <div class="actions">
        <a class="button primary" id="room-link" target="_blank" rel="noreferrer">Open private room</a>
      </div>
    </section>
  </main>
  <footer>Bound to 127.0.0.1 for this setup session.</footer>

  <script nonce="${nonce}">
    const state = { identity: null, guilds: [], finished: false, studioEnabled: false };
    const byId = (id) => document.getElementById(id);

    async function api(route, options) {
      const response = await fetch(route, {
        ...(options || {}),
        headers: { "Content-Type": "application/json", ...((options && options.headers) || {}) }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Setup request failed.");
      return payload;
    }

    function setStatus(id, text, ready) {
      const element = byId(id);
      element.textContent = text;
      element.className = "status " + (ready ? "ready" : "waiting");
    }

    function setStep(id, done, active) {
      const element = byId(id);
      element.className = "step" + (done ? " done" : "") + (active ? " active" : "");
      if (done) element.querySelector(".step-number").textContent = "✓";
    }

    function showError(id, error) {
      const element = byId(id);
      element.textContent = error ? error.message || String(error) : "";
      element.classList.toggle("visible", Boolean(error));
    }

    function setBusy(button, busy, label) {
      button.disabled = busy;
      button.innerHTML = busy ? '<span class="spinner"></span>' + label : label;
    }

    function renderIdentity(payload) {
      state.identity = payload.identity;
      state.guilds = payload.guilds || [];
      byId("bot-name").textContent = "@" + payload.identity.username;
      byId("avatar-wrap").innerHTML = payload.identity.avatarUrl
        ? '<img class="avatar" alt="" src="' + payload.identity.avatarUrl + '">'
        : '<div class="avatar-fallback">DB</div>';
      byId("identity").classList.add("visible");
      byId("install-actions").classList.remove("hidden");
      byId("install-link").href = payload.installUrl;
      byId("token-form").classList.add("hidden");
      byId("token").value = "";
      byId("enable-studio").disabled = false;
      setStatus("discord-status", "Connected", true);
      setStep("step-system", true, false);
      setStep("step-discord", true, false);
      setStep("step-workspace", false, true);
      renderGuilds();
    }

    function renderStudio(enabled) {
      state.studioEnabled = Boolean(enabled);
      byId("studio-opt-in").classList.toggle("hidden", state.studioEnabled);
      byId("studio-config").classList.toggle("hidden", !state.studioEnabled);
      setStatus("studio-status", state.studioEnabled ? "Enabled" : "Skipped", state.studioEnabled);
    }

    function renderGuilds() {
      const select = byId("guild");
      const previous = select.value;
      select.innerHTML = "";
      if (!state.guilds.length) {
        select.append(new Option("Add the bot to a server, then refresh", ""));
        select.disabled = true;
      } else {
        select.append(new Option("Choose a server", ""));
        state.guilds.forEach((guild) => select.append(new Option(guild.name, guild.id)));
        select.disabled = false;
        if (state.guilds.some((guild) => guild.id === previous)) select.value = previous;
        if (state.guilds.length === 1) select.value = state.guilds[0].id;
      }
      updateFinishReadiness();
    }

    function updateFinishReadiness() {
      const ready = Boolean(state.identity && byId("guild").value && byId("repo-path").value.trim());
      byId("finish-button").disabled = !ready;
      setStatus("workspace-status", ready ? "Ready" : "Waiting", ready);
    }

    async function refreshGuilds() {
      showError("discord-error");
      const button = byId("refresh-guilds");
      setBusy(button, true, "Checking");
      try {
        const payload = await api("/api/guilds");
        state.guilds = payload.guilds;
        renderGuilds();
      } catch (error) {
        showError("discord-error", error);
      } finally {
        setBusy(button, false, "Refresh servers");
      }
    }

    byId("token-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("discord-error");
      const button = byId("connect-button");
      setBusy(button, true, "Connecting");
      try {
        const payload = await api("/api/connect", { method: "POST", body: JSON.stringify({ token: byId("token").value }) });
        renderIdentity(payload);
      } catch (error) {
        showError("discord-error", error);
      } finally {
        setBusy(button, false, "Connect application");
      }
    });

    byId("refresh-guilds").addEventListener("click", refreshGuilds);
    byId("install-link").addEventListener("click", () => setTimeout(refreshGuilds, 3500));
    byId("guild").addEventListener("change", updateFinishReadiness);
    byId("repo-path").addEventListener("input", () => {
      const pathValue = byId("repo-path").value.trim().replace(/[\\/]+$/, "");
      if (!byId("repo-name").dataset.edited && pathValue) {
        byId("repo-name").value = pathValue.split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      }
      updateFinishReadiness();
    });
    byId("repo-name").addEventListener("input", () => { byId("repo-name").dataset.edited = "true"; updateFinishReadiness(); });
    byId("enable-studio").addEventListener("click", () => renderStudio(true));
    byId("disable-studio").addEventListener("click", () => renderStudio(false));
    byId("choose-folder").addEventListener("click", async () => {
      showError("finish-error");
      const button = byId("choose-folder");
      setBusy(button, true, "Choosing");
      try {
        const result = await api("/api/pick-folder", { method: "POST", body: "{}" });
        byId("repo-path").value = result.repositoryPath;
        byId("repo-name").value = result.repositoryName;
        byId("repo-name").dataset.edited = "true";
        updateFinishReadiness();
      } catch (error) {
        showError("finish-error", error);
      } finally {
        setBusy(button, false, "Choose folder");
      }
    });

    byId("finish-button").addEventListener("click", async () => {
      showError("finish-error");
      const button = byId("finish-button");
      setBusy(button, true, "Finishing");
      try {
        const result = await api("/api/finish", {
          method: "POST",
          body: JSON.stringify({
            guildId: byId("guild").value,
            repositoryPath: byId("repo-path").value,
            repositoryName: byId("repo-name").value,
            enableStudio: state.studioEnabled
          })
        });
        state.finished = true;
        byId("setup-workspace").classList.add("hidden");
        byId("success").classList.add("visible");
        byId("room-link").href = result.channelUrl;
        byId("success-copy").textContent = "Private room and workspace launcher created in " + result.guildName + " with " + result.repositoryName + " selected. " +
          (result.studioEnabled ? "Discord-native Studio is enabled. " : "Studio was skipped. ") +
          (result.alreadyRunning ? "Restart the existing Devbot process to apply setup changes." : "Keep this terminal open while Devbot runs.");
        byId("success-explore").textContent = result.studioEnabled ? "/studio" : "Ask or Status";
        setStep("step-system", true, false);
        setStep("step-discord", true, false);
        setStep("step-workspace", true, true);
      } catch (error) {
        showError("finish-error", error);
      } finally {
        setBusy(button, false, "Finish setup");
      }
    });

    (async () => {
      try {
        const payload = await api("/api/state");
        byId("node-check").textContent = payload.node.version;
        byId("node-check").className = payload.node.ready ? "good" : "bad";
        byId("codex-check").textContent = payload.codex.label;
        byId("codex-check").className = payload.codex.ready ? "good" : "bad";
        setStatus("system-status", payload.node.ready && payload.codex.ready ? "Ready" : "Needs attention", payload.node.ready && payload.codex.ready);
        renderStudio(payload.studioEnabled);
        if (payload.identity) renderIdentity(payload);
      } catch (error) {
        byId("codex-check").textContent = error.message || String(error);
        byId("codex-check").className = "bad";
        setStatus("system-status", "Needs attention", false);
      }
    })();
  </script>
</body>
</html>`;
}
