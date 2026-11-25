import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function exerciseEnhancements({ page, expect, fixture, paletteAction }) {
  const nav = (name) => page.locator(".sidebar").getByRole("button", { name, exact: true });
  const workspace = () => page.evaluate(() => JSON.parse(localStorage.getItem("vexssh.workspace.v1")));
  const tabIds = () => page.locator(".session-tab").evaluateAll((tabs) => tabs.map((tab) => tab.dataset.sessionId));
  const tab = (id) => page.locator(`.session-tab[data-session-id="${id}"] [role="tab"]`);
  const activeId = () => page.getByRole("tab", { selected: true }).evaluate((button) => button.closest(".session-tab").dataset.sessionId);
  const actions = () => page.evaluate(() => window.fixture.calls.map((call) => call.args?.action).filter(Boolean));
  async function rename(id, name) {
    await tab(id).dblclick();
    const dialog = page.getByRole("dialog", { name: "Rename terminal", exact: true });
    await dialog.getByLabel("Terminal name", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(tab(id)).toHaveAccessibleName(name);
  }
  async function sessionMenu(id, name) {
    await tab(id).click({ button: "right" });
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  async function appearance(keyboard = false) {
    await page.getByRole("button", { name: "More terminal actions", exact: true }).click();
    if (keyboard) {
      await page.getByRole("menuitem", { name: /^Appearance/ }).focus();
      await page.keyboard.press("ArrowRight");
    } else await page.getByRole("menuitem", { name: /^Appearance/ }).hover();
    await expect(page.getByRole("menuitemradio", { name: "Readable mono", exact: true })).toBeVisible();
    if (keyboard) await expect(page.getByRole("menuitemradio", { name: "Host default", exact: true })).toBeFocused();
    if (!keyboard) {
      await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
      const target = page.getByRole("menuitemradio", { name: "Readable mono", exact: true });
      const point = await target.boundingBox();
      await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2, { steps: 12 });
    }
  }
  const activeRecord = async () => {
    const value = await workspace();
    return value.tabs.find((item) => item.tabId === value.activeTabId);
  };

  await nav("Terminal").click();
  const originalId = (await tabIds())[0];
  await rename(originalId, "Persisted console");
  await tab(originalId).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to group", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: "Operations", exact: true }).click();
  await expect.poll(async () => (await activeRecord()).groupId).toBe("fixture-ops");
  await appearance(true);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "Application default", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "Readable mono", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await activeRecord()).terminalProfileId).toBe("fixture-readable");
  await appearance();
  await page.getByRole("menuitemradio", { name: "Readable mono", exact: true }).click();
  await expect.poll(async () => (await activeRecord()).terminalProfileId).toBe("fixture-readable");
  await appearance();
  await page.getByRole("menuitem", { name: "Increase font size", exact: true }).click();
  await expect.poll(async () => (await activeRecord()).fontSize).toBe(17);
  await page.getByRole("menuitem", { name: "Decrease font size", exact: true }).click();
  await expect.poll(async () => (await activeRecord()).fontSize).toBe(16);
  await page.getByRole("menuitem", { name: "Reset font size", exact: true }).click();
  await expect.poll(async () => (await activeRecord()).fontSize).toBeUndefined();
  await appearance();
  await page.getByRole("menuitem", { name: "Increase font size", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await activeRecord()).fontSize).toBe(17);

  await sessionMenu(originalId, "Duplicate connection");
  await expect(page.getByRole("tab")).toHaveCount(2);
  const duplicateId = (await tabIds()).find((id) => id !== originalId);
  await rename(duplicateId, "Duplicate console");
  assert.equal((await activeRecord()).terminalProfileId, "fixture-readable");
  assert.equal((await activeRecord()).fontSize, 17);
  assert.equal((await activeRecord()).groupId, "fixture-ops");
  await tab(duplicateId).focus();
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect.poll(tabIds).toEqual([duplicateId, originalId]);
  await expect.poll(async () => (await workspace()).tabs.map((item) => item.name)).toEqual(["Duplicate console", "Persisted console"]);
  const beforeReload = await workspace();
  await page.reload();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Ready to reconnect", exact: true })).toBeVisible();
  const afterReload = await workspace();
  assert.deepEqual(afterReload.tabs, beforeReload.tabs);
  assert.equal(afterReload.activeTabId, beforeReload.activeTabId);
  assert.equal(afterReload.fileTabId, beforeReload.fileTabId);
  assert.deepEqual(await tabIds(), beforeReload.tabs.map((item) => `saved-${item.tabId}`));
  assert.equal(await activeId(), `saved-${beforeReload.activeTabId}`);
  assert.deepEqual((await actions()).filter((action) => ["ssh_connect", "ssh_attach", "ssh_write"].includes(action)), []);
  await expect(page.locator(".xterm")).toHaveCount(0);
  await page.locator(".terminal-pane.focused").getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(activeId).not.toMatch(/^saved-/);
  await expect(page.getByRole("tab")).toHaveCount(2);
  const reconnectedId = await activeId();
  assert(!reconnectedId.startsWith("saved-"));
  assert.notEqual(reconnectedId, duplicateId);
  const afterReconnect = await workspace();
  assert.deepEqual(afterReconnect.tabs, beforeReload.tabs);
  assert.equal(afterReconnect.activeTabId, beforeReload.activeTabId);
  assert.equal((await actions()).filter((action) => action === "ssh_connect").length, 1);
  assert.equal((await actions()).filter((action) => action === "ssh_write").length, 0);

  await sessionMenu(reconnectedId, "Duplicate connection");
  await expect(page.getByRole("tab")).toHaveCount(3);
  const survivorId = await activeId();
  const disconnectsBefore = (await actions()).filter((action) => action === "ssh_disconnect").length;
  await sessionMenu(survivorId, "Close other tabs");
  let closeDialog = page.getByRole("dialog", { name: "Close 2 tabs?", exact: true });
  await closeDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  assert.equal((await actions()).filter((action) => action === "ssh_disconnect").length, disconnectsBefore);
  await sessionMenu(survivorId, "Close other tabs");
  closeDialog = page.getByRole("dialog", { name: "Close 2 tabs?", exact: true });
  await closeDialog.getByRole("button", { name: "Close tabs", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  assert.equal(await activeId(), survivorId);
  assert.equal((await actions()).filter((action) => action === "ssh_disconnect").length, disconnectsBefore + 1);

  await page.getByRole("button", {name:"Restore layout", exact:true}).click();
  await nav("Hosts").click();
  const row = page.locator(".connection-card").filter({ hasText: fixture.state_load.hosts[0].hostname });
  await row.getByRole("button", { name: `Actions for ${fixture.state_load.hosts[0].name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit host", exact: true }).click();
  const hostDialog = page.getByRole("dialog", { name: "Edit host", exact: true });
  await hostDialog.getByText("Environment", { exact: true }).locator("..").locator("select").selectOption("production");
  await hostDialog.getByRole("button", { name: "Save host", exact: true }).click();
  await expect(hostDialog).not.toBeVisible();
  await expect(row.locator(".environment-badge")).toHaveText("Production");
  await nav("Terminal").click();
  await expect(page.locator(".session-tab .environment-badge")).toHaveText("Production");
  await page.getByRole("group", { name: "Session view" }).getByRole("button", { name: "SFTP", exact: true }).click();
  await expect(page.locator('[data-file-side="remote"] .environment-badge')).toHaveText("Production");
  await nav("Terminal").click();
  const newTab = page.getByRole("button", { name: "New terminal (Ctrl+Shift+T)", exact: true });
  await newTab.focus();
  await expect(page.getByRole("tooltip")).toContainText("New terminal");
  await page.keyboard.press("Escape");

  await paletteAction("Open settings");
  const categories = page.getByRole("navigation", { name: "Settings categories", exact: true });
  await categories.getByRole("button", { name: "General", exact: true }).click();
  const restore = page.getByRole("checkbox", { name: "Restore tabs and layout when VEXSSH opens", exact: true });
  await restore.uncheck();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("vexssh.workspace.v1"))).toBeNull();
  await restore.check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("vexssh.workspace.v1") !== null)).toBe(true);
  await categories.getByRole("button", { name: "Updates", exact: true }).click();
  const updates = page.locator(".updates-panel");
  const choose = updates.getByRole("button", { name: "Choose update package", exact: true });
  await page.evaluate(() => { window.fixture.holdUpdatePrepare = true; });
  const idleWidth = (await choose.boundingBox()).width;
  await choose.click();
  await expect(choose).toHaveAttribute("aria-busy", "true");
  await expect(choose).toHaveAccessibleName("Choose update package");
  const busyWidth = (await choose.boundingBox()).width;
  assert(Math.abs(idleWidth - busyWidth) < 1, `Busy button changed width: ${idleWidth} -> ${busyWidth}`);
  await page.evaluate(() => { window.fixture.holdUpdatePrepare = false; window.fixture.releaseUpdatePrepare(); });
  await expect(updates.locator(".update-summary")).toContainText("is ready");
  await updates.getByRole("button", { name: "Install when VEXSSH closes", exact: true }).click();
  await expect(updates).toContainText("This update will install when you close VEXSSH");
  await updates.getByRole("button", { name: "Cancel scheduled update", exact: true }).click();
  await expect(updates.locator(".update-summary")).toHaveCount(0);
  await page.evaluate(() => { window.fixture.updateError = "Fixture update package is invalid"; });
  await choose.click();
  await expect(updates.getByRole("alert")).toContainText("Fixture update package is invalid");
  await page.evaluate(() => { window.fixture.updateError = null; window.fixture.update.pendingError = "Fixture pending update is damaged"; window.fixture.update.canCancel = true; });
  await updates.getByRole("button", { name: "Refresh status", exact: true }).click();
  await updates.getByRole("button", { name: "Clear pending update", exact: true }).click();
  await expect(updates.getByRole("button", { name: "Clear pending update", exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.fixture.sessions.size), 1);

  const capture = fileURLToPath(new URL("../../../work/", import.meta.url));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await categories.getByRole("button", { name: "Appearance", exact: true }).click();
  for (const theme of ["dark", "light"]) {
    await page.locator(".theme-options").getByRole("button", { name: theme[0].toUpperCase() + theme.slice(1), exact: true }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await nav("Terminal").click();
    await page.setViewportSize({ width: 760, height: 560 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const durations = await newTab.evaluate((button) => getComputedStyle(button).transitionDuration.split(",").map(parseFloat));
    assert(durations.every((duration) => duration <= 0.001));
    await page.screenshot({ path: resolve(capture, `desktop-enhancements-${theme}-760.png`) });
    await paletteAction("Open settings");
  }
  await nav("Terminal").click();
  assert.equal((await actions()).filter((action) => action === "ssh_write").length, 0);
  return {
    reloadPreservesTabIdsOrderNamesAndAppearance: true,
    savedTabsDoNotConnectOrConstructXterm: true,
    explicitReconnectPreservesMetadataWithNewNativeId: true,
    duplicateAndGroupMenus: true,
    fontProfileZoomAndReset: true,
    mouseAndKeyboardAppearanceMenus: true,
    closeOthersCancelAndConfirm: true,
    consistentEnvironmentLabels: true,
    workspaceToggle: true,
    updateChooseScheduleCancelAndErrors: true,
    stableBusyButtonWidth: true,
    busyButtonKeepsAccessibleName: true,
    keyboardTooltip: true,
    reducedMotionAndNarrowThemes: true,
  };
}
