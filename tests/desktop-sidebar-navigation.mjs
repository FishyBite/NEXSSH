import assert from "node:assert/strict";

export async function exerciseSidebarNavigation({ page, expect, nav }) {
  const sidebar = page.locator(".sidebar");
  const label = nav("Hosts").getByText("Hosts", { exact: true });
  const toggle = title => sidebar.getByTitle(title, { exact: true });
  const mode = name => page.getByRole("group", { name: "Session view" }).getByRole("button", { name, exact: true });
  const button = name => page.getByRole("button", { name, exact: true });
  const shell = page.locator(".terminal-pane.focused:visible");
  const sidebarWidth = () => sidebar.evaluate(el => Math.round(el.getBoundingClientRect().width));
  const firstNavOffset = () => nav("Hosts").evaluate(el => {
    const rail = el.closest(".sidebar");
    return Math.round(el.getBoundingClientRect().top - rail.getBoundingClientRect().top + rail.scrollTop);
  });
  const compactSaved = () => page.evaluate(() => window.fixture.config.settings.sidebarCollapsed);

  async function checkSidebar(compact, width, offset) {
    await expect(sidebar).toBeVisible();
    await expect(toggle(compact ? "Expand sidebar" : "Collapse sidebar")).toBeVisible();
    if (compact) await expect(label).toBeHidden();
    else await expect(label).toBeVisible();
    if (width !== undefined) await expect.poll(sidebarWidth).toBe(width);
    if (offset !== undefined) await expect.poll(firstNavOffset).toBe(offset);
  }

  const sessionIds = await page.evaluate(() => [...window.fixture.sessions.keys()]);
  assert.equal(sessionIds.length, 1);
  // A deliberately expanded terminal has its own Restore layout control.
  await nav("Terminal").click();
  if (await button("Restore layout").isVisible()) await button("Restore layout").click();

  const viewports = [1380, 760, 680];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport, height: 900 });
    await nav("Hosts").click();
    await checkSidebar(false);
    await sidebar.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const expandedWidth = await sidebarWidth();
    const navOffset = await firstNavOffset();

    await nav("Terminal").click();
    await checkSidebar(false, expandedWidth, navOffset);
    await expect(shell).toHaveAttribute("data-session-id", sessionIds[0]);
    await nav("Files").click();
    await expect(page.getByRole("heading", { name: "File manager", exact: true })).toBeVisible();
    await checkSidebar(false, expandedWidth, navOffset);
    await mode("Database").click();
    await expect(mode("Database")).toHaveAttribute("aria-pressed", "true");
    await checkSidebar(false, expandedWidth, navOffset);
    await mode("Terminal").click();
    await expect(shell.locator(".xterm-helper-textarea")).toBeFocused();

    await page.keyboard.press("Control+Shift+f");
    const search = shell.getByRole("textbox", { name: "Search terminal output" });
    await expect(search).toBeFocused();
    await search.press("Control+Shift+Enter");
    await expect(button("Expand terminal")).toBeVisible();
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(shell.locator(".xterm-helper-textarea")).toBeFocused();
    const writes = () => page.evaluate(() => window.fixture.calls.filter(call => call.args?.action === "ssh_write").length);
    const writesBefore = await writes();
    await page.keyboard.press("Control+Shift+Enter");
    await expect(button("Restore layout")).toBeVisible();
    await expect(shell.locator(".xterm-helper-textarea")).toBeFocused();
    await shell.locator(".xterm-helper-textarea").dispatchEvent("keydown", {
      key: "Enter", ctrlKey: true, shiftKey: true, repeat: true,
    });
    await expect(button("Restore layout")).toBeVisible();
    await page.keyboard.press("Control+Shift+Enter");
    await expect(button("Expand terminal")).toBeVisible();
    assert.equal(await writes(), writesBefore, "A layout shortcut must not send Enter to the shell");
    await button("Expand terminal").click();
    await expect(sidebar).toBeHidden();
    await expect(shell.locator(".xterm-helper-textarea")).toBeFocused();
    await button("Restore layout").click();
    await expect(shell.locator(".xterm-helper-textarea")).toBeFocused();
    await checkSidebar(false, expandedWidth);
    await nav("Files").click();
    await toggle("Collapse sidebar").click();
    await expect.poll(compactSaved).toBe(true);
    await checkSidebar(true);
    await sidebar.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const compactWidth = await sidebarWidth();
    assert(compactWidth < expandedWidth, "Compact sidebar must actually be narrower");
    for (const destination of ["Hosts", "Terminal", "Files"]) {
      await nav(destination).click();
      await checkSidebar(true, compactWidth);
    }
    await mode("Database").click();
    await checkSidebar(true, compactWidth);
    await toggle("Expand sidebar").click();
    await expect.poll(compactSaved).toBe(false);
    await nav("Hosts").click();
    await checkSidebar(false, expandedWidth);
  }
  assert.deepEqual(await page.evaluate(() => [...window.fixture.sessions.keys()]), sessionIds);
  await nav("Files").click();
  await toggle("Collapse sidebar").click();
  await expect.poll(compactSaved).toBe(true);
  await page.reload();
  await checkSidebar(true);
  await nav("Settings").click();
  const preference = page.getByRole("checkbox", { name: "Compact sidebar" });
  await expect(preference).toBeChecked();
  const light = page.locator(".theme-options").getByRole("button", { name: "Light", exact: true });
  await light.click();
  await toggle("Expand sidebar").click();
  await expect(preference).not.toBeChecked();
  await toggle("Collapse sidebar").click();
  await expect(preference).toBeChecked();
  await expect(light).toHaveAttribute("aria-pressed", "true");
  assert.equal(await page.evaluate(() => window.fixture.config.settings.theme), "dark");
  await preference.uncheck();
  await button("Save changes").click();
  await expect.poll(compactSaved).toBe(false);
  await page.reload();
  await nav("Terminal").click();
  await checkSidebar(false);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  return { viewports, preservedSession: true, terminalFocus: true, compactAndExpandedPersisted: true, settingsDraftPreserved: true };
}
