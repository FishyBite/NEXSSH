import assert from "node:assert/strict";

export async function exerciseDrawerResize({ page, expect }) {
  const id = await page.evaluate(() => [...window.fixture.sessions.keys()][0]);
  const shell = page.locator('.terminal-pane[data-session-id="' + id + '"] .xterm-helper-textarea');
  const mode = (name) => page.getByRole("group", { name: "Session view" }).getByRole("button", { name, exact: true });
  const panel = page.getByRole("complementary", { name: /^Remote files for / });
  const toggle = page.getByRole("button", { name: "Remote files panel", exact: true });
  const slider = page.getByRole("separator", { name: "Resize remote files panel" });
  const width = () => panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const height = () => panel.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  async function drag(dx, dy) {
    const box = await slider.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await mode("Terminal").click();
  await toggle.click();
  await expect(slider).toHaveAttribute("aria-orientation", "vertical");
  const initial = await width();
  await shell.focus();
  await drag(-100, 0);
  await expect.poll(width).toBe(initial + 100);
  await expect(shell).toBeFocused();
  await page.keyboard.type("r");
  await expect.poll(() => page.evaluate(() => window.fixture.calls.filter(c => c.args?.action === "ssh_write").at(-1)?.args.payload)).toEqual({ sessionId: id, data: "r" });
  await mode("SFTP").click();
  await mode("Terminal").click();
  await expect.poll(width).toBe(initial + 100);
  await slider.dblclick();
  await expect.poll(width).toBe(initial);
  await slider.focus();
  await slider.press("ArrowLeft");
  await expect.poll(width).toBe(initial + 16);
  await slider.press("Home");
  await expect.poll(width).toBe(initial);
  await page.setViewportSize({ width: 760, height: 560 });
  await expect(slider).toBeVisible();
  assert.ok(await panel.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
  // Force a stacked content area independently of sidebar/expanded preferences.
  const surface = page.locator(".terminal-surface:visible");
  await surface.evaluate(el => { el.style.maxWidth = "470px"; });
  await expect(slider).toHaveAttribute("aria-orientation", "horizontal");
  const baseline = await height();
  await drag(0, -20);
  await expect.poll(height).toBeGreaterThan(baseline);
  await slider.dblclick();
  await expect.poll(height).toBe(baseline);
  await surface.evaluate(el => { el.style.maxWidth = ""; });
  await panel.getByRole("button", { name: /close remote files/i }).click();
  await expect(shell).toBeFocused();
  assert.deepEqual(await page.evaluate(() => [...window.fixture.sessions.keys()]), [id]);
  return { drag: true, keyboard: true, stacked: true, reset: true, retainedThroughSftp: true, immediateTyping: true };
}
