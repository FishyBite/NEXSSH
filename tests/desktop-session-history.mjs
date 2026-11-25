import assert from "node:assert/strict";

export async function exerciseSessionHistory({ page, expect, fixture }) {
  const host = fixture.state_load.hosts[0];
  await page.evaluate(() => {
    const state = window.fixture;
    state.historyProbe = { attempts: [], folders: [] };
    const transport = window.__TAURI_INTERNALS__;
    const invoke = transport.invoke.bind(transport);
    transport.invoke = async (command, args = {}) => {
      if (command !== "request") return invoke(command, args);
      const { action, payload } = args;
      const probe = state.historyProbe;
      if (action === "file_list" && payload.side === "remote") {
        probe.folders.push({ id: payload.sessionId, path: payload.path });
        const path = payload.path === "." ? "/home/fixture" : payload.path;
        return { path, entries: [{ name: "marker", path: path + "/marker", isDir: false,
          isSymlink: false, size: 0, modified: 0, permissions: "644" }] };
      }
      if (action === "ssh_connect") {
        probe.attempts.push({ host: payload.hostId, trust: !!payload.trustFingerprint });
        if (probe.hold) {
          probe.hold = false;
          await new Promise(resolve => { probe.release = resolve; });
        }
        if (probe.changedKey && !payload.trustFingerprint)
          return { verificationRequired: true, changed: true, hostId: payload.hostId,
            fingerprint: "SHA256:fixture-new", previousFingerprint: "SHA256:fixture-old" };
        if (probe.changedKey && payload.trustFingerprint) {
          state.routeRevision = (state.routeRevision || 1) + 1;
          probe.changedKey = false;
        }
        if (!payload.verifyOnly && probe.rejectOnce) {
          probe.rejectOnce = false;
          throw new Error("Server rejected fixture identity");
        }
      }
      return invoke(command, args);
    };
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const selected = () => page.getByRole("tab", { selected: true });
  const selectedId = () => selected().locator("..").getAttribute("data-session-id");
  const shell = (id) => page.locator('.terminal-pane[data-session-id="' + id + '"] .xterm-helper-textarea');
  const mode = (name) => page.getByRole("group", { name: "Session view" }).getByRole("button", { name, exact: true });
  const folder = page.getByRole("textbox", { name: "remote directory path", exact: true });
  const setFolder = async (path) => {
    await folder.fill(path);
    await folder.press("Enter");
    await expect(page.locator('[data-file-side="remote"] [data-file-path="' + path + '/marker"]')).toBeVisible();
  };
  const rename = async (newName) => {
    await selected().dblclick();
    await page.getByRole("textbox", { name: "Terminal name", exact: true }).fill(newName);
    await button("Rename").click();
    await expect(tab(newName)).toHaveAttribute("aria-selected", "true");
  };
  const palette = page.getByRole("dialog", { name: "Quick connect", exact: true });
  const choose = async (prefix) => {
    await button("New terminal (Ctrl+Shift+T)").click();
    await palette.getByRole("button", { name: new RegExp("^" + prefix) }).click();
    await expect(palette).toHaveCount(0);
  };
  const newTerminal = async (label) => {
    const previousId = await selectedId();
    await choose(host.name + " ");
    await expect.poll(selectedId).not.toBe(previousId);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await rename(label);
  };
  const attemptCount = () => page.evaluate(() => window.fixture.historyProbe.attempts.length);
  const ids = () => page.evaluate(() => [...window.fixture.sessions.keys()]);
  const toggle = () => page.keyboard.press("Control+Shift+Space");
  const original = await selectedId();
  await rename("Deploy");
  await setFolder("/deploy");
  await newTerminal("Scratch");
  await newTerminal("Logs");
  const idLogs = await selectedId();
  await tab("Deploy").click();
  await toggle();
  await expect(tab("Logs")).toHaveAttribute("aria-selected", "true");
  await expect(shell(idLogs)).toBeFocused();
  await page.keyboard.type("l");
  await expect.poll(() => page.evaluate(() => window.fixture.calls.filter((c) =>
    c.args?.action === "ssh_write").at(-1)?.args.payload)).toEqual({ sessionId: idLogs, data: "l" });
  await toggle();
  await expect(shell(original)).toBeFocused();
  await page.keyboard.press("Control+Tab");
  await expect(tab("Scratch")).toHaveAttribute("aria-selected", "true");
  await choose("Switch to previous tab");
  await expect(tab("Deploy")).toHaveAttribute("aria-selected", "true");
  await expect(shell(original)).toBeFocused();
  await mode("SFTP").click();
  await tab("Logs").click();
  await setFolder("/logs");
  await folder.focus();
  await toggle();
  await expect(tab("Logs")).toHaveAttribute("aria-selected", "true");
  await mode("SFTP").focus();
  await toggle();
  await expect(tab("Deploy")).toHaveAttribute("aria-selected", "true");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed", "true");
  await expect(folder).toHaveValue("/deploy");
  await button("Close Deploy").click();
  await expect(tab("Deploy")).toHaveCount(0);
  await expect(tab("Logs")).toHaveAttribute("aria-selected", "true");
  await setFolder("/logs/current");
  const before = await attemptCount();
  await page.evaluate(() => { window.fixture.historyProbe.hold = true; });
  await choose("Reopen last closed tab");
  await expect.poll(attemptCount).toBe(before + 1);
  await button("Cancel").click();
  await page.evaluate(() => window.fixture.historyProbe.release());
  await expect(tab("Deploy")).toHaveCount(0);
  await page.evaluate(() => { window.fixture.historyProbe.rejectOnce = true; });
  await choose("Reopen last closed tab");
  await expect(page.getByRole("alert")).toContainText("Server rejected fixture identity");
  await expect(tab("Deploy")).toHaveCount(0);
  await button("Connect").click();
  await expect(tab("Deploy")).toHaveAttribute("aria-selected", "true");
  const reopened = await selectedId();
  assert.notEqual(reopened, original);
  assert.ok(!(await ids()).includes(original));
  assert.equal((await ids()).length, 3);
  await expect(folder).toHaveValue("/deploy");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed", "true");
  assert.deepEqual(await page.evaluate((from) => window.fixture.historyProbe.attempts.slice(from), before), [
    { host: host.id, trust: false }, { host: host.id, trust: false }, { host: host.id, trust: false },
  ]);
  await mode("Terminal").click();
  await expect(shell(reopened)).toBeFocused();
  await page.keyboard.type("d");
  await expect.poll(() => page.evaluate(() => window.fixture.calls.filter((c) =>
    c.args?.action === "ssh_write").at(-1)?.args.payload)).toEqual({ sessionId: reopened, data: "d" });

  // A changed server identity requires explicit approval and a fresh home listing.
  await mode("SFTP").click();
  await button("Close Deploy").click();
  await page.evaluate(() => { window.fixture.historyProbe.changedKey = true; });
  await choose("Reopen last closed tab");
  await expect(page.getByRole("dialog", { name: "Server identity has changed" })).toBeVisible();
  assert.equal((await ids()).length, 2);
  await button("Trust fingerprint & continue").click();
  await expect(tab("Deploy")).toHaveAttribute("aria-selected", "true");
  await expect(folder).toHaveValue("/home/fixture");
  const newId = await selectedId();
  const listed = await page.evaluate((id) => window.fixture.historyProbe.folders.filter((item) => item.id === id), newId);
  assert.ok(listed.length && listed.every((item) => item.path !== "/deploy"));

  // Another session can verify a rotated host or jump key while this tab is closed.
  await setFolder("/old-identity");
  await button("Close Deploy").click();
  await page.evaluate(() => { window.fixture.historyProbe.changedKey = true; });
  await choose(host.name + " ");
  await button("Trust fingerprint & continue").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(shell(await selectedId())).toBeFocused();
  await choose("Reopen last closed tab");
  await expect(tab("Deploy")).toHaveAttribute("aria-selected", "true");
  await expect(folder).toHaveValue("/home/fixture");
  const latest = await selectedId();
  assert.deepEqual(await page.evaluate((id) => window.fixture.historyProbe.folders.filter((entry) =>
    entry.id === id).map((entry) => entry.path), latest), ["."]);
  await button("New terminal (Ctrl+Shift+T)").click();
  await expect(palette.getByRole("button", { name: /^Reopen last closed tab/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  return { recentAndOrderedSwitch: true, protectedInput: true, preservedModeAndFocus: true,
    freshVerifiedReopen: true, cancellationAndAuthRetry: true, nameAndFolderRestored: true,
    changedIdentityStartsAtHome: true, siblingRotationStartsAtHome: true };
}
