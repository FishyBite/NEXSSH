import assert from "node:assert/strict";
import { resolve } from "node:path";

export async function exerciseImmersive({page, expect, fixture}) {
  const button = (name, scope = page) => scope.getByRole("button", {name, exact:true});
  const first = fixture.state_load.hosts[0];
  const trigger = button("Sidebar");
  const host = button(first.name, page.locator(".connections-grid"));
  const shell = page.locator(".terminal-pane.focused .xterm-helper-textarea");
  const tabs = page.getByRole("group", {name:"Session view"});
  const dialog = page.getByRole("dialog");
  // A host awaiting its identity or credentials must leave the original view intact.
  await page.evaluate(() => {
    const api = window.__TAURI_INTERNALS__;
    const invoke = api.invoke.bind(api);
    api.invoke = (command, args) => {
      if (args?.action === "ssh_connect" && !window.fixture.approved)
        return Promise.resolve({credentialRequired:"password", hostId:args.payload.hostId, routeToken:"fixture", message:"Enter password."});
      return invoke(command, args);
    };
  });
  await host.click();
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await button("Cancel", dialog).click();
  await expect(host).toBeVisible();
  await page.evaluate(() => {window.fixture.approved = true;});
  await host.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(shell).toBeFocused();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".statusbar")).toBeHidden();
  await expect(page.locator(".terminal-toolbar")).toBeHidden();
  const pane = page.locator(".terminal-pane.focused");
  const id = await pane.getAttribute("data-session-id");
  const box = await pane.boundingBox();
  assert(box.width >= page.viewportSize().width - 4);
  if (process.env.VEXSSH_IMMERSIVE_CAPTURE) {
    const directory = process.env.VEXSSH_IMMERSIVE_CAPTURE;
    await page.screenshot({path:resolve(directory,"vexssh-ssh-focus.png")});
    await trigger.click();
    await expect(button("Terminal",page.locator(".sidebar"))).toBeFocused();
    await page.locator(".sidebar").evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    await page.screenshot({path:resolve(directory,"vexssh-sidebar-open.png")});
    await trigger.click();
  }
  const closeAndType = async (close) => {
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded","true");
    await expect(button("Terminal", page.locator(".sidebar"))).toBeFocused();
    const bounds = await pane.boundingBox();
    assert.equal(bounds.x,box.x);
    assert.equal(bounds.width,box.width);
    await close();
    await expect(trigger).toHaveAttribute("aria-expanded","false");
    await expect(shell).toBeFocused();
    await page.keyboard.type("z");
    await expect.poll(() => page.evaluate(() => window.fixture.calls.filter(c => c.args?.action === "ssh_write").at(-1)?.args.payload)).toMatchObject({sessionId:id,data:"z"});
  };
  await closeAndType(() => page.keyboard.press("Escape"));
  await closeAndType(() => page.locator(".session-sidebar-backdrop").click({position:{x:page.viewportSize().width-25,y:65}}));
  await closeAndType(() => trigger.click());
  await trigger.click();
  await button("Quick connect",page.locator(".sidebar")).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shell).toBeFocused();
  await button("Terminal tools").click();
  await expect(button("More terminal actions")).toBeVisible();
  await trigger.click();
  await button("Files", page.locator(".sidebar")).click();
  await expect(button("SFTP",tabs)).toHaveAttribute("aria-pressed","true");
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator('[data-file-side="remote"]')).toContainText(".profile");
  await button("Database",tabs).click();
  await expect(button("Database",tabs)).toHaveAttribute("aria-pressed","true");
  await button("Terminal",tabs).click();
  await expect(shell).toBeFocused();
  await expect(pane).toHaveAttribute("data-session-id",id);
  await trigger.click();
  await button("Hosts",page.locator(".sidebar")).click();
  await expect(host).toBeVisible();
  await expect(page.locator(".sidebar")).toBeVisible();
  await button("Terminal",page.locator(".sidebar")).click();
  await expect(trigger).toHaveAttribute("aria-expanded","false");
  await button("Restore layout").click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(shell).toBeFocused();
  assert.deepEqual(await page.evaluate(() => [...window.fixture.sessions.keys()]),[id]);
  const focusId = () => pane.getAttribute("data-session-id");
  const writes = () => page.evaluate(() => window.fixture.calls.filter(c => c.args?.action === "ssh_write").length);
  const tabId = await page.evaluate(() => JSON.parse(localStorage.getItem("nexssh.workspace.v1")).activeTabId);
  await page.locator(`.session-tab[data-session-id="${id}"] .session-tab-menu`).click();
  await page.getByRole("menuitem",{name:"Duplicate connection"}).click();
  await expect.poll(focusId).not.toBe(id);
  const peerId = await focusId();
  await page.locator(`.session-tab[data-session-id="${id}"] [role="tab"]`).click();
  await button("Restore layout").click();
  const output = "retained-fixture-output";
  await page.evaluate(({id,output}) => window.fixture.emit("terminal-data", {sessionId:id, data:btoa("\r\n" + output + "\r\n")}), {id,output});
  await expect(pane.locator(".xterm-rows")).toContainText(output);
  const drop = async (id, status) => {
    await page.evaluate(({id,status}) => {
      window.fixture.sessions.delete(id);
      window.fixture.emit("terminal-status", {sessionId:id, status, error:status === "error" ? "transport closed" : undefined});
    }, {id,status});
    await expect(button("Reconnect",pane)).toBeVisible();
  };
  await drop(id,"error");
  await expect(pane).toContainText("SSH connection lost");
  await expect(pane.locator(".xterm-rows")).toContainText(output);
  const before = await writes();
  await shell.focus();
  await page.keyboard.type("offline");
  await button("Reconnect",pane).click();
  await expect.poll(focusId).not.toBe(id);
  const nextId = await focusId();
  await expect(trigger).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await pane.locator(".previous-shell-output summary").click();
  await expect(pane.getByLabel("Previous shell output")).toContainText(output);
  assert.equal(await writes(),before);

  await button("Expand terminal").click();
  await drop(nextId,"disconnected");
  await expect(pane).toContainText("SSH session ended");
  await button("Reconnect",pane).click();
  await expect.poll(focusId).not.toBe(nextId);
  const recoveredId = await focusId();
  assert.deepEqual(new Set(await page.evaluate(() => [...window.fixture.sessions.keys()])), new Set([peerId,recoveredId]));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("nexssh.workspace.v1")).activeTabId),tabId);
  await expect(trigger).toHaveAttribute("aria-expanded","false");
  assert.equal(await writes(),before);
  await page.evaluate(({id,tabId,hostId}) => {
    for (const name of ["alpha","beta"]) window.fixture.emit("transfer-progress", {
      id:name, sessionId:id, tabId, routeToken:hostId+":1", source:"/"+name, destination:"/saved/"+name,
      direction:"download", protocol:"sftp", status:"failed", resumable:true,
      totalBytes:100, transferredBytes:15, speedBytesPerSecond:0, etaSeconds:null, startedAt:1,
    });
    const api = window.__TAURI_INTERNALS__, invoke = api.invoke.bind(api);
    api.invoke = (command,args) => {
      if (args?.action === "transfer_resume") {
        window.fixture.resumed = args.payload;
        return Promise.resolve({});
      }
      return invoke(command,args);
    };
  }, {id,tabId,hostId:first.id});
  await page.getByRole("button",{name:/Choose a file to resume/}).click();
  await page.getByRole("menuitem",{name:/Download \/beta/}).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.resumed), {id:"beta",requiredSessionId:recoveredId,tabId});
  await trigger.click();
  await button("Pin sidebar").click();
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveAttribute("data-session-drawer","pinned");
  await expect(page.locator(".session-sidebar-backdrop")).toHaveCount(0);
  assert((await pane.boundingBox()).x >= (await sidebar.boundingBox()).width - 1);
  await shell.focus();
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeVisible();
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-session-drawer","pinned");
  await button("Connect",pane).click();
  await expect(shell).toBeFocused();
  await button("Unpin sidebar").click();
  await expect(sidebar).toBeHidden();
  await expect(shell).toBeFocused();
  await page.reload();
  await expect(trigger).toHaveAttribute("aria-expanded","false");
  return {afterAuthentication:true, edgeToEdge:true, drawerKeepsGeometry:true, keyboardReturnsToSession:true, filesAndDatabase:true, restoresDockedLayout:true,
    pinnedAcrossLaunches:true, reconnectInBothLayouts:true, outputRetained:true, noInputReplayed:true, perFileResume:true};
}
