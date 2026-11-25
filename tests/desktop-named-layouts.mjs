import assert from "node:assert/strict";

export async function exerciseNamedLayouts({page, expect, fixture, nav}) {
  const button = (name) => page.getByRole("button", {name, exact:true});
  const ids = () => page.evaluate(() => [...window.fixture.sessions.keys()]);
  const openLayouts = async () => {
    await page.keyboard.press("Control+Shift+p");
    const palette = page.getByRole("dialog", {name:"Command palette"});
    await palette.getByRole("textbox", {name:"Search commands"}).fill("Saved layouts");
    await palette.getByRole("button", {name:/^Saved layouts/}).click();
    await expect(page.getByRole("dialog", {name:"Saved layouts"})).toBeVisible();
  };
  await nav("Terminal").click();
  await nav("Hosts").click();
  const second = fixture.state_load.hosts[1];
  await page.locator(".connection-card").getByRole("button", {name:second.name, exact:true}).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await button("Terminal tools").click();
  await button("Split terminal").click();
  await page.getByRole("menuitemradio", {name:"Split side by side"}).click();
  const divider = page.getByRole("separator", {name:/resize/i});
  await divider.press("ArrowRight");
  const ratio = Number(await divider.getAttribute("aria-valuenow"));
  await page.getByRole("group", {name:"Session view"}).getByRole("button", {name:"SFTP", exact:true}).click();
  const remotePane = page.locator('[data-file-side="remote"]:visible').filter({hasText:second.name});
  await expect(remotePane).toContainText(".profile");
  await openLayouts();
  await page.getByRole("textbox", {name:"Layout name"}).fill("Ops pair");
  await button("Save current split").click();
  const open = button("Open layout Ops pair");
  await expect(open).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("nexssh.layouts.v1.fixture-workspace"))[0]);
  assert.equal(saved.ratio, ratio);
  const files = saved.panes.find(pane => pane.view === "Files" && pane.hostId === second.id);
  assert.equal(files.hostId, second.id);
  assert.deepEqual(files.folders, {local:"C:\\Users\\Test User", remote:"/var/home/test-user"});
  const live = await ids();
  await open.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.deepEqual(await ids(), live);
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await openLayouts();
  const heldHost = saved.panes[1].hostId;
  await page.evaluate(hostId => {
    const api = window.__TAURI_INTERNALS__;
    const invoke = api.invoke.bind(api);
    api.invoke = (command, args) => {
      if (command === "request" && args.action === "ssh_connect" && args.payload.hostId === hostId && !window.fixture.allowLayoutHost) {
        return Promise.resolve({credentialRequired:"password", hostId, routeToken:"fixture", message:"Enter password"});
      }
      return invoke(command, args);
    };
  }, heldHost);
  await open.click();
  const prompt = page.getByRole("dialog", {name:/Connect to/});
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", {name:"Cancel", exact:true}).click();
  await expect.poll(ids).toHaveLength(0);
  await page.evaluate(() => { window.fixture.allowLayoutHost = true; });
  await openLayouts();
  await open.click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(divider).toHaveAttribute("aria-valuenow", String(ratio));
  await expect(remotePane).toContainText(".profile");
  const calls = await page.evaluate(() => window.fixture.calls.filter(call => call.args?.action === "file_list").map(call => call.args.payload));
  assert.ok(calls.some(call => call.side === "local" && call.path === files.folders.local));
  assert.ok(calls.some(call => call.side === "remote" && call.path === files.folders.remote));
  return {savedPair:true, liveReuse:true, coldCancellation:true, reopenedFolders:true};
}
