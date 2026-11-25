import assert from "node:assert/strict";

export async function exerciseDrawerDownload({ page, expect, fixture }) {
  const host = fixture.state_load.hosts[0].name;
  const tab = (n) => page.getByRole("tab", {name: host + " · " + n, exact: true});
  const terminal = (id) => page.locator('.terminal-pane[data-session-id="' + id + '"] .xterm-helper-textarea');
  const drawer = page.getByRole("complementary", {name: /^Remote files for /});
  const list = drawer.getByRole("group", {name: "Remote entries"});
  const filter = drawer.getByRole("textbox", {name: "Filter remote files"});
  const firstFile = drawer.getByRole("button", {name: "Select nginx.conf", exact: true});
  const download = drawer.getByRole("button", {name: /^Download .*to…$/});
  const reveal = drawer.getByRole("button", {name: "Show in Explorer"});
  const sessions = () => page.evaluate(() => [...window.fixture.sessions.keys()]);
  const calls = (action) => page.evaluate((action) =>
    window.fixture.calls.filter(c => c.args?.action === action).map(c => c.args.payload), action);
  const probe = () => page.evaluate(() => window.fixture.drawerDownloadProbe);
  await page.evaluate(() => {
    const state = window.fixture;
    const ipc = window.__TAURI_INTERNALS__;
    const invoke = ipc.invoke.bind(ipc);
    const test = state.drawerDownloadProbe = {choices: [], jobs: [], edits: [], reveals: []};
    ipc.invoke = async (command, args = {}) => {
      if (command === "plugin:dialog|open" && args.options.directory) {
        test.choices.push(args.options);
        return new Promise(resolve => state.finishFolderChoice = resolve);
      }
      if (command !== "request") return invoke(command, args);
      const {action, payload} = args;
      if (action === "file_list" && payload.side === "remote") {
        if (!state.sessions.has(payload.sessionId)) throw Error("Unknown fixture session");
        const path = payload.path === "." ? "/home/fixture" : payload.path;
        return {path, entries: ["configs", "nginx.conf", "notes.txt"].map((name, i) => ({
          name, path: path + "/" + name, isDir: i === 0, isSymlink: false, size: 8,
          modified: 1700000000, permissions: "644",
        }))};
      }
      if (action === "file_preview_path") {
        test.edits.push({action, ...payload});
        return {kind: "file", path: payload.path, content: "original\n", revision: "first"};
      }
      if (action === "file_save") {
        test.edits.push({action, ...payload});
        return {revision: "updated"};
      }
      if (action === "transfer_start") {
        if (!state.sessions.has(payload.sessionId)) throw Error("Unknown transfer session");
        const job = {...payload, id: "download-" + test.jobs.length, status: "queued",
          totalBytes: 8, transferredBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, startedAt: Date.now()};
        test.jobs.push(job);
        return job;
      }
      if (action === "transfer_list") return test.jobs;
      if (action === "transfer_reveal") {
        test.reveals.push(payload.id);
        return true;
      }
      return invoke(command, args);
    };
  });

  const [a] = await sessions();
  await page.getByRole("button", {name: "Remote folder actions"}).click();
  await page.getByRole("menuitem", {name: "Open terminal here"}).click();
  await expect(tab(2)).toHaveAttribute("aria-selected", "true");
  const [, b] = await sessions();
  assert.ok(a && b && a !== b);
  const connectCount = (await calls("ssh_connect")).length;
  await tab(1).click();
  await expect(terminal(a)).toBeFocused();
  await page.keyboard.press("F6");
  await expect(firstFile).toBeVisible();
  await expect.poll(() => list.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.type("nGi");
  await expect(filter).toHaveValue("nGi");
  await expect(drawer.getByRole("button", {name: "Select notes.txt", exact: true})).toHaveCount(0);
  await filter.press("ArrowDown");
  await expect(firstFile).toBeFocused();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", {name: "Edit file"});
  await expect(editor).toBeVisible();
  await editor.locator(".cm-content").press("End");
  await page.keyboard.type("updated");
  await editor.getByRole("button", {name: "Save", exact: true}).click();
  await expect(editor).toContainText("Saved with backup");
  const edits = (await probe()).edits;
  assert.deepEqual(edits.map(edit => [edit.action, edit.sessionId]), [["file_preview_path", a], ["file_save", a]]);
  assert.equal(edits[0].path, edits[1].path);
  assert.ok(edits[1].content.includes("updated"));
  await editor.getByRole("button", {name: "Back to terminal"}).click();
  await expect(terminal(a)).toBeFocused();
  await page.keyboard.type("x");
  await expect.poll(async () => (await calls("ssh_write")).at(-1)).toEqual({sessionId: a, data: "x"});
  await page.keyboard.press("F6");
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await firstFile.click();
  const choose = async (number) => {
    await download.click();
    await expect.poll(async () => (await probe()).choices.length).toBe(number);
    return (await probe()).choices.at(-1);
  };
  const finish = (folder) => page.evaluate(path => window.fixture.finishFolderChoice(path), folder);
  assert.equal((await choose(1)).defaultPath, undefined);
  await finish(null);
  await expect(terminal(a)).toBeFocused();
  assert.equal((await probe()).jobs.length, 0);
  await drawer.getByRole("checkbox", {name: "Include notes.txt in selection"}).check();
  await expect(download).toHaveAccessibleName("Download 2 to…");
  await choose(2);
  const target = "C:\\Downloads\\active tab";
  await finish(target);
  await expect(terminal(a)).toBeFocused();
  await page.keyboard.type("y");
  await expect.poll(async () => (await calls("ssh_write")).at(-1)).toEqual({sessionId: a, data: "y"});
  await expect.poll(async () => (await probe()).jobs.length).toBe(2);
  const jobs = (await probe()).jobs;
  assert.deepEqual(jobs.map(job => [job.sessionId, job.destination, job.direction, job.protocol]), [
    [a, target + "\\nginx.conf", "download", "sftp"],
    [a, target + "\\notes.txt", "download", "sftp"],
  ]);
  assert.ok(jobs[0].batchId && jobs[0].batchId === jobs[1].batchId);
  await expect(reveal).toHaveCount(0);
  await tab(2).click();
  await expect(terminal(b)).toBeFocused();
  const saved = target + "\\nginx (1).conf";
  await page.evaluate(({id, saved}) => {
    const state = window.fixture;
    const job = state.drawerDownloadProbe.jobs.find(job => job.id === id);
    Object.assign(job, {status: "completed", transferredBytes: job.totalBytes,
      renamedPaths: {[job.destination]: saved}, finishedAt: Date.now()});
    state.emit("transfer-progress", job);
  }, {id: jobs[0].id, saved});
  await expect(terminal(b)).toBeFocused();
  await page.keyboard.press("F6");
  await expect(firstFile).toBeVisible();
  await expect(reveal).toHaveCount(0);
  await firstFile.click();
  assert.equal((await choose(3)).defaultPath, undefined);
  // Simulate a session switch while a delayed native dialog response is in flight.
  await tab(1).click();
  await expect(terminal(a)).toBeFocused();
  await finish("C:\\Downloads\\stale");
  await expect(reveal).toHaveAttribute("title", saved);
  await reveal.click();
  assert.deepEqual((await probe()).reveals, [jobs[0].id]);
  await firstFile.click();
  assert.equal((await choose(4)).defaultPath, target);
  await finish(null);
  await expect(terminal(a)).toBeFocused();
  await page.keyboard.press("F6");
  await page.keyboard.type("notes");
  await expect(filter).toHaveValue("notes");
  await page.keyboard.press("F6");
  await expect(terminal(a)).toBeFocused();
  await page.keyboard.type("z");
  await expect.poll(async () => (await calls("ssh_write")).at(-1)).toEqual({sessionId: a, data: "z"});
  assert.equal((await probe()).jobs.length, 2);
  assert.equal((await calls("ssh_connect")).length, connectCount);
  assert.deepEqual(await sessions(), [a, b]);
  return {multiDownload: true, sameSessionEditAndSave: true, keyboardRoundTrip: true,
    destinationPerTab: true, backgroundCompletion: true, explorerReveal: true, staleChooser: true};
}
