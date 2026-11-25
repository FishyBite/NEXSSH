import assert from "node:assert/strict";

export async function exerciseRemoteDrawer({ page, expect, fixture }) {
  const host = fixture.state_load.hosts[0];
  const id = await page.evaluate(() => [...window.fixture.sessions.keys()][0]);
  const mode = (name) => page.getByRole("group", {name:"Session view"}).getByRole("button", {name, exact:true});
  const drawer = page.getByRole("complementary", {name:/^Remote files for /});
  const toggle = page.getByRole("button", {name:"Remote files panel", exact:true});
  const address = drawer.getByRole("textbox", {name:"Remote folder path"});
  const fullPath = page.getByRole("textbox", {name:"remote directory path", exact:true});
  const terminal = (sessionId) => page.locator('.terminal-pane[data-session-id="'+sessionId+'"] .xterm-helper-textarea');
  const writeLog = () => page.evaluate(() => window.fixture.calls.filter(c => c.args?.action === "ssh_write").map(c => c.args.payload));
  const report = (sessionId, uri) => page.evaluate(({sessionId, uri}) => {
    window.fixture.emit("terminal-data", {sessionId, data:btoa("\x1b]7;"+uri+"\x1b\\")});
  }, {sessionId, uri});
  const file = drawer.getByRole("button", {name:"Select owner's readme.txt", exact:true});
  const follow = drawer.getByRole("checkbox", {name:"Follow terminal folder"});
  await page.evaluate(() => {
    const transport = window.__TAURI_INTERNALS__;
    const invoke = transport.invoke.bind(transport);
    const state = window.fixture;
    state.remoteReads = [];
    transport.invoke = async (cmd, args = {}) => {
      if (cmd !== "request" || args.action !== "file_list" || args.payload.side !== "remote")
        return invoke(cmd, args);
      const {sessionId, path} = args.payload;
      if (!state.sessions.has(sessionId)) throw new Error("Disconnected session");
      state.remoteReads.push({sessionId, path});
      if (state.followWaiters && path.startsWith("/slow-")) {
        await new Promise(resolve => state.followWaiters.push(resolve));
      }
      if (path === "/delayed") await new Promise(resolve => { state.releaseFolder = resolve; });
      if (path === "/denied") throw new Error("Permission denied");
      const dir = path === "." ? "/home/fixture" : path;
      return {path:dir, entries:["Documents", "owner's readme.txt"].map((name,index) => ({
        path:dir+"/"+name, name, isDir:index===0, isSymlink:false, size:12, modified:1794450000, permissions:"644",
      }))};
    };
  });

  await mode("Terminal").click();
  await toggle.click();
  await expect(file).toBeVisible();
  await expect(follow).not.toBeChecked();
  await follow.check();
  await expect(drawer.getByText(/waiting for the shell/i)).toBeVisible();
  await report(id, "file://"+host.hostname+"/srv/Project%20A");
  await expect(address).toHaveValue("/srv/Project A");
  await expect(file).toBeVisible();
  await file.click();
  await drawer.getByRole("button", {name:"Insert path into terminal"}).click();
  await expect(terminal(id)).toBeFocused();
  await page.keyboard.type("x");
  const writes = [
    {sessionId:id,data:"'/srv/Project A/owner'\\''s readme.txt'"},
    {sessionId:id,data:"x"},
  ];
  await expect.poll(writeLog).toEqual(writes);

  // The same follow switch works with the full two-pane manager while xterm is hidden.
  await mode("SFTP").click();
  await expect(fullPath).toHaveValue("/srv/Project A");
  await report(id, "file:///var/log/service");
  await expect(fullPath).toHaveValue("/var/log/service");
  async function slowReports(group) {
    await page.evaluate(() => { window.fixture.followWaiters = []; });
    for (let n=1; n<=5; n++) {
      await report(id, "file:///slow-"+group+"-"+n);
      // Each prompt must reach the UI separately, beyond OSC output coalescing.
      await page.waitForTimeout(320);
    }
    const count = await page.evaluate(() => window.fixture.followWaiters.length);
    assert.ok(count >= 1 && count <= 2, "Expected bounded SFTP requests, got "+count);
  }
  const releaseFollows = () => page.evaluate(() => {
    const pending = window.fixture.followWaiters;
    delete window.fixture.followWaiters;
    pending.forEach(done => done());
  });
  await slowReports("latest");
  await releaseFollows();
  await expect(fullPath).toHaveValue("/slow-latest-5");
  await slowReports("manual");
  await fullPath.fill("/chosen");
  await fullPath.press("Enter");
  await expect(page.locator('[data-file-path="/chosen/Documents"]')).toBeVisible();
  await releaseFollows();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(fullPath).toHaveValue("/chosen");
  assert.equal(await page.evaluate(() => window.fixture.remoteReads.some(r => r.path === "/slow-manual-5")),false);
  const fullFollow = page.getByRole("button", {name:"Follow terminal folder", exact:true});
  await expect(fullFollow).toHaveAttribute("aria-pressed","true");
  await fullFollow.click();
  await fullPath.fill("/manual");
  await fullPath.press("Enter");
  await expect(page.locator('[data-file-path="/manual/Documents"]')).toBeVisible();
  await report(id, "file:///background");
  await mode("Terminal").click();
  if (!await drawer.isVisible()) await toggle.click();
  await expect(address).toHaveValue("/manual");
  await expect(follow).not.toBeChecked();
  await drawer.getByRole("button", {name:"Open folder Documents", exact:true}).click();
  await expect(address).toHaveValue("/manual/Documents");
  await expect(file).toBeVisible();
  await mode("SFTP").click();
  await expect(fullPath).toHaveValue("/manual/Documents");

  // Another shell on the same host has its own folder, shell reports, and follow switch.
  await page.getByRole("button", {name:"Remote folder actions"}).click();
  await page.getByRole("menuitem", {name:"Open terminal here"}).click();
  const second = page.getByRole("tab", {name:host.name+" · 2", exact:true});
  const first = page.getByRole("tab", {name:host.name+" · 1", exact:true});
  await expect(second).toHaveAttribute("aria-selected","true");
  const secondId = await page.evaluate(() => [...window.fixture.sessions.keys()][1]);
  assert.notEqual(secondId, id);
  if (!await drawer.isVisible()) await toggle.click();
  await follow.check();
  await report(secondId, "file:///deploy");
  await expect(address).toHaveValue("/deploy");
  await expect(file).toBeVisible();
  await report(id, "file:///from-first");
  await report(secondId, "file://wrong.example.invalid/unrelated");
  await report(secondId, "file:///%0Ainvalid");
  await address.fill("/delayed");
  await address.press("Enter");
  await expect.poll(() => page.evaluate(() => typeof window.fixture.releaseFolder)).toBe("function");
  await first.click();
  if (!await drawer.isVisible()) await toggle.click();
  await expect(address).toHaveValue("/manual/Documents");
  await expect(follow).not.toBeChecked();
  await page.evaluate(() => window.fixture.releaseFolder());
  await expect(file).toBeVisible();
  assert.equal(await page.evaluate(() => window.fixture.remoteReads.some(r => r.path==="/unrelated" || r.path.includes("\n"))),false);

  await address.fill("/denied");
  await address.press("Enter");
  await expect(drawer.getByRole("alert")).toContainText("Permission denied");
  await drawer.getByRole("button",{name:"Parent remote folder"}).click();
  await expect(file).toBeVisible();
  await file.click();
  await page.evaluate(() => {window.fixture.holdTargetCheck = true;});
  await drawer.getByRole("button", {name:"Insert path into terminal"}).click();
  await expect.poll(() => page.evaluate(() => typeof window.fixture.finishTargetCheck)).toBe("function");
  await second.click();
  await page.evaluate(async () => {window.fixture.finishTargetCheck(); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  assert.deepEqual(await writeLog(),writes);
  if (!await drawer.isVisible()) await toggle.click();
  await expect(follow).toBeChecked();
  await expect(address).toHaveValue("/deploy");
  if (process.env.NEXSSH_DRAWER_CAPTURE) await page.screenshot({path:process.env.NEXSSH_DRAWER_CAPTURE});
  await page.setViewportSize({width:760,height:560});
  await expect(drawer).toBeInViewport();
  await expect(terminal(secondId).locator("xpath=ancestor::*[contains(@class,'terminal-pane')][1]")).toBeInViewport();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await drawer.getByRole("button", {name:"Close remote files panel"}).click();
  await expect(terminal(secondId)).toBeFocused();
  await page.keyboard.type("y");
  await expect.poll(writeLog).toEqual([...writes,{sessionId:secondId,data:"y"}]);
  return { scopedDirectories:true, followsInBothViews:true, boundedFollowRequests:true, manualNavigation:true, quotedPathAndImmediateTyping:true,
    staleListIgnored:true, staleInsertionIgnored:true, recoverableFolderError:true, narrowWorkspace:true };
}
