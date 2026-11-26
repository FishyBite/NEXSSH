import assert from "node:assert/strict";

export async function exerciseSessionTargets({ page, expect, nav, fixture }) {
  const [hostA, hostB] = fixture.state_load.hosts;
  const name = host => "Snippet for " + host.name;
  const button = (container, title) => container.getByRole("button", { name: title, exact: true });
  const dialog = page.getByRole("dialog");
  const disconnect = id => page.evaluate(sessionId => {
    window.fixture.sessions.delete(sessionId);
    window.fixture.emit("terminal-status", { sessionId, status: "disconnected" });
  }, id);
  if (!await nav("Hosts").isVisible()) await button(page, "Sidebar").click();
  await nav("Hosts").click();
  await button(page.locator(".connection-card").filter({ hasText: hostB.hostname }), hostB.name).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(dialog).not.toBeVisible();
  const restoreLayout = button(page, "Restore layout");
  if (await restoreLayout.isVisible()) await restoreLayout.click();
  const [idA, idB] = await page.evaluate(() => [...window.fixture.sessions.keys()]);
  assert(idA && idB && idA !== idB);

  await nav("Hosts").click();
  const connection = page.locator(".topbar .active-connection");
  const status = page.locator(".statusbar");
  await expect(connection).toHaveText(hostB.name);
  await expect(status).toContainText("2 active SSH sessions");
  await connection.click();
  await expect(page.getByRole("tab", { name: hostB.name, exact: true })).toHaveAttribute("aria-selected", "true");
  await nav("Serial").click();
  await expect(page.getByRole("heading", { name: "Serial console" })).toBeVisible();
  await expect(connection).toHaveCount(0);
  await expect(status.getByText(hostB.name, { exact: true })).toHaveCount(0);
  await nav("Terminal").click();

  await page.keyboard.press("Control+Shift+p");
  await dialog.getByRole("textbox").fill(name(hostA));
  await expect(dialog.getByText("No matching hosts or commands.")).toBeVisible();
  await dialog.getByRole("textbox").fill(name(hostB));
  await dialog.getByRole("button", { name: new RegExp(name(hostB)) }).click();
  await expect(button(dialog, "Execute on " + hostB.name)).toBeEnabled();
  await dialog.getByLabel("Command to execute").fill("echo reviewed");
  await button(dialog, "Execute on " + hostB.name).click();
  const writes = () => page.evaluate(() => window.fixture.calls
    .filter(call => call.args?.action === "ssh_write").map(call => call.args.payload));
  const command = { sessionId: idB, data: "echo reviewed\r" };
  await expect.poll(writes).toEqual([command]);
  await page.getByRole("tab", { name: hostA.name, exact: true }).click();
  await page.getByRole("tab", { name: hostB.name, exact: true }).click();
  assert.deepEqual(await writes(), [command]);

  await page.evaluate(({ idA, idB }) => {
    const api = window.__TAURI_INTERNALS__;
    const invoke = api.invoke.bind(api);
    const state = window.fixture;
    const rules = [idA, idB].map((sessionId, i) => ({
      id: "fixture-rule-" + i, sessionId, bindPort: 14001+i, targetPort: 8787, type: "local",
      bindHost: "127.0.0.1", targetHost: "127.0.0.1", status: "active",
    }));
    state.tunnelWrites = [];
    api.invoke = async (cmd, args = {}) => {
      if (cmd === "request" && args.action === "tunnels_list") return rules;
      if (cmd === "request" && args.action === "tunnels_update") {
        state.tunnelWrites.push(args.payload);
        return { ok: true };
      }
      return invoke(cmd,args);
    };
  }, { idA, idB });
  await nav("Tunnels").click();
  const ruleA = page.locator(".tunnel-row").filter({ hasText: "14001" });
  const ruleB = page.locator(".tunnel-row").filter({ hasText: "14002" });
  await expect(ruleA).toContainText(hostA.name);
  await expect(ruleB).toContainText(hostB.name);
  await button(ruleA, "Edit forwarding rule").click();
  await expect(dialog).toContainText("Route traffic through " + hostA.name);
  await button(dialog, "Save changes").click();
  await expect(dialog).not.toBeVisible();
  assert.equal(await page.evaluate(() => window.fixture.tunnelWrites[0].sessionId), idA);
  await button(ruleA, "Edit forwarding rule").click();
  await disconnect(idA);
  await expect(button(dialog, "Save changes")).toBeDisabled();
  await button(dialog, "Cancel").click();
  await button(page, "New tunnel").click();
  await expect(dialog).toContainText("Route traffic through " + hostB.name);
  await expect(dialog.getByLabel("Listen port")).toHaveValue("8080");
  await button(dialog, "Cancel").click();

  await nav("Snippets").click();
  await expect(page.getByText(name(hostA), { exact: true })).toHaveCount(0);
  assert.deepEqual(await writes(), [command], "Returning from a lazy-loaded view replayed the old command");
  await button(page, "Review & run").click();
  await dialog.getByLabel("Command to execute").fill("echo reviewed");
  await button(dialog, "Execute on " + hostB.name).click();
  await expect.poll(writes).toEqual([command, command]);
  await nav("Snippets").click();
  await button(page, "Review & run").click();
  const execute = button(dialog, "Execute on " + hostB.name);
  await expect(execute).toBeEnabled();
  await disconnect(idB);
  await expect(execute).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("reviewed SSH session");
  assert.deepEqual(await writes(), [command, command]);
  await button(dialog, "Cancel").click();
  await nav("Hosts").click();
  await expect(status).toContainText("0 active SSH sessions");
  await expect(status.getByText(hostB.name, { exact: true })).toHaveCount(0);
  await expect(status).not.toContainText(/\d+ ms/);
  await expect(connection).toHaveCount(0);
  await nav("Terminal").click();
  await expect(page.getByRole("tab", { name: hostB.name, exact: true })).toHaveAttribute("aria-selected", "true");
}
