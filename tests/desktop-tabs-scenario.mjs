import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function exerciseTabReordering({ page, expect, fixture, paletteAction }) {
  await page.setViewportSize({ width: 1800, height: 900 });
  for (const host of fixture.state_load.hosts.filter((host) => host.id.startsWith("fixture-drag-"))) {
    await paletteAction(host.name);
    await expect(page.getByRole("tab", { name: host.name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("tab")).toHaveCount(8);
  await expect(page.locator(".terminal-pane .xterm")).toHaveCount(8);
  await page.getByRole("button",{name:"Restore layout",exact:true}).click();
  const order = () => page.locator(".session-tab").evaluateAll((tabs) => tabs.map((tab) => tab.dataset.sessionId));
  const tab = (id) => page.locator(`.session-tab[data-session-id="${id}"] [role="tab"]`);
  const selected = () => page.getByRole("tab", { selected: true }).evaluate((button) => button.closest(".session-tab").dataset.sessionId);
  const initial = await order();
  assert.equal(new Set(initial).size, 8);
  assert(initial.every(Boolean));
  await tab(initial[0]).click();
  await expect.poll(selected).toBe(initial[0]);
  const baseline = await page.evaluate(() => {
    window.fixture.initialTerminalNodes = new Map(
      [...document.querySelectorAll(".terminal-pane")].map((pane) => [pane.dataset.sessionId, pane.querySelector(".xterm")]),
    );
    return { sessions: [...window.fixture.sessions.keys()], calls: window.fixture.calls.length };
  });

  async function unchangedConnections() {
    const current = await page.evaluate((offset) => ({
      sessions: [...window.fixture.sessions.keys()],
      forbiddenCalls: window.fixture.calls.slice(offset).filter((call) =>
        ["ssh_connect", "ssh_disconnect", "ssh_write", "ssh_attach"].includes(call.args?.action),
      ).map((call) => call.args.action),
      terminalNodesPreserved: [...document.querySelectorAll(".terminal-pane")].every((pane) =>
        window.fixture.initialTerminalNodes.get(pane.dataset.sessionId) === pane.querySelector(".xterm"),
      ),
    }), baseline.calls);
    assert.deepEqual(current.sessions, baseline.sessions);
    assert.deepEqual(current.forbiddenCalls, []);
    assert.equal(current.terminalNodesPreserved, true);
    assert.deepEqual([...(await order())].sort(), [...initial].sort());
  }

  async function tabPoint(button, side) {
    return button.evaluate((element, side) => {
      const r = element.getBoundingClientRect();
      const x = side === "before" ? r.left + 4 : side === "after" ? r.right - 4 : r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return { x, y, hitsTab: element.contains(document.elementFromPoint(x, y)) };
    }, side);
  }
  async function startDrag(sourceId, targetId, side) {
    const source = tab(sourceId);
    const target = tab(targetId);
    await target.scrollIntoViewIfNeeded();
    await source.scrollIntoViewIfNeeded();
    const from = await tabPoint(source, "center");
    const to = await tabPoint(target, side);
    assert(from.hitsTab && to.hitsTab, "Both ends of the drag must be visible and hit the intended tab");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 14 });
    await expect(page.locator(`.session-tab.drag-source[data-session-id="${sourceId}"]`)).toHaveCount(1);
  }
  async function pointerMove(sourceId, targetId, side) {
    await startDrag(sourceId, targetId, side);
    await page.mouse.up();
  }

  await pointerMove(initial[1], initial[3], "after");
  let expected = [initial[0], initial[2], initial[3], initial[1], ...initial.slice(4)];
  await expect.poll(order).toEqual(expected);
  await expect.poll(selected).toBe(initial[0]);
  await pointerMove(initial[1], initial[2], "before");
  expected = [...initial];
  await expect.poll(order).toEqual(expected);
  await expect.poll(selected).toBe(initial[0]);
  await unchangedConnections();

  const preview = page.locator(".terminal-split-preview");
  const ghost = page.locator(".terminal-tab-ghost");
  const panes = page.locator(".terminal-panes");
  const pane = id => panes.locator('.terminal-pane[data-session-id="' + id + '"]');
  const screenOrder = () => panes.locator(".terminal-pane:visible").evaluateAll(elements =>
    elements.sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map(element => element.dataset.sessionId));
  async function dragToPane(id, side) {
    await tab(id).scrollIntoViewIfNeeded();
    const start = await tabPoint(tab(id), "center");
    const area = await panes.boundingBox();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * (side === "left" ? .25 : .75), area.y + area.height / 2, { steps: 12 });
    await expect(ghost).toHaveCount(0);
    await expect(preview.locator(".receiving-pane")).toContainText("on the " + side);
  }
  await dragToPane(initial[2], "left");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect.poll(screenOrder).toEqual([initial[0]]);

  await startDrag(initial[2], initial[3], "after");
  const toolbar = await page.locator(".terminal-toolbar").boundingBox();
  await page.mouse.move(toolbar.x + toolbar.width / 2, toolbar.y + toolbar.height / 2);
  await expect(ghost).toHaveCount(0);
  await expect(preview).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(order).toEqual(initial);
  await expect.poll(screenOrder).toEqual([initial[0]]);

  await dragToPane(initial[1], "left");
  await page.mouse.up();
  await expect.poll(screenOrder).toEqual([initial[1], initial[0]]);
  await expect(pane(initial[1]).locator(".xterm-helper-textarea")).toBeFocused();
  await pane(initial[0]).locator(".xterm-screen").click();
  await expect.poll(selected).toBe(initial[0]);
  await expect.poll(screenOrder).toEqual([initial[1], initial[0]]);
  await page.setViewportSize({ width: 760, height: 560 });
  await dragToPane(initial[1], "right");
  await page.mouse.up();
  await expect.poll(screenOrder).toEqual([initial[0], initial[1]]);
  const left = await pane(initial[0]).boundingBox();
  const right = await pane(initial[1]).boundingBox();
  assert(right.x >= left.x + left.width - 1 && Math.abs(right.y - left.y) < 1);
  await expect(pane(initial[1]).locator(".xterm-helper-textarea")).toBeFocused();
  await expect.poll(order).toEqual(initial);
  await unchangedConnections();
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.getByRole("button", { name: "Split terminal", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Single pane", exact: true }).click();
  await tab(initial[0]).click();

  await page.getByRole("button", { name: "Split terminal", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Split side by side", exact: true }).click();
  await tab(initial[1]).click();
  await expect.poll(selected).toBe(initial[1]);
  const visiblePanes = () => page.locator(".terminal-pane").evaluateAll((panes) =>
    panes.filter((pane) => pane.getBoundingClientRect().width > 0).map((pane) => {
      const bounds = pane.getBoundingClientRect();
      return { id: pane.dataset.sessionId, bounds: [bounds.x, bounds.y, bounds.width, bounds.height].map((value) => Math.round(value * 100) / 100) };
    }),
  );
  const splitBefore = await visiblePanes();
  assert.deepEqual(splitBefore.map((pane) => pane.id), initial.slice(0, 2));
  await pointerMove(initial[2], initial[0], "before");
  await expect.poll(order).toEqual([initial[2], initial[0], initial[1], ...initial.slice(3)]);
  await expect.poll(selected).toBe(initial[1]);
  await expect.poll(visiblePanes).toEqual(splitBefore);
  await unchangedConnections();
  await pointerMove(initial[2], initial[1], "after");
  await expect.poll(order).toEqual(initial);
  await expect.poll(visiblePanes).toEqual(splitBefore);
  await page.getByRole("button", { name: "Split terminal", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Single pane", exact: true }).click();
  await tab(initial[0]).click();
  await expect.poll(selected).toBe(initial[0]);

  await startDrag(initial[1], initial[3], "after");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(order).toEqual(expected);
  await expect.poll(selected).toBe(initial[0]);

  await tab(initial[0]).focus();
  await page.keyboard.press("Control+Shift+ArrowRight");
  expected = [initial[1], initial[0], ...initial.slice(2)];
  await expect.poll(order).toEqual(expected);
  await expect.poll(selected).toBe(initial[0]);
  await page.keyboard.press("Control+Shift+ArrowLeft");
  expected = [...initial];
  await expect.poll(order).toEqual(expected);
  await expect.poll(selected).toBe(initial[0]);
  await unchangedConnections();

  await page.setViewportSize({ width: 760, height: 560 });
  const strip = page.getByRole("tablist", { name: "Terminal sessions", exact: true });
  await expect.poll(() => strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await strip.evaluate((element) => { element.scrollLeft = 0; });
  const overflowSource = await tab(initial[0]).boundingBox();
  const stripBounds = await strip.boundingBox();
  await page.mouse.move(overflowSource.x + overflowSource.width / 2, overflowSource.y + overflowSource.height / 2);
  await page.mouse.down();
  await page.mouse.move(stripBounds.x + stripBounds.width - 5, stripBounds.y + stripBounds.height / 2, { steps: 16 });
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft), { timeout: 5000 }).toBeGreaterThan(80);
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft + element.clientWidth >= element.scrollWidth - 3), { timeout: 7000 }).toBe(true);
  const last = await tab(initial.at(-1)).evaluate((button) => {
    const wrapper = button.closest(".session-tab");
    const strip = button.closest('[role="tablist"]');
    const bounds = strip.getBoundingClientRect();
    return { x: bounds.x + wrapper.offsetLeft - strip.scrollLeft, y: bounds.y, width: wrapper.offsetWidth, height: wrapper.offsetHeight };
  });
  await page.mouse.move(last.x + last.width - 4, last.y + last.height / 2, { steps: 5 });
  await page.mouse.up();
  expected = [...initial.slice(1), initial[0]];
  await expect.poll(order).toEqual(expected);
  await expect.poll(selected).toBe(initial[0]);
  await unchangedConnections();

  await page.setViewportSize({ width: 1800, height: 900 });
  await tab(initial[2]).click();
  await expect.poll(selected).toBe(initial[2]);
  await tab(initial[2]).dblclick();
  const rename = page.getByRole("dialog", { name: "Rename terminal", exact: true });
  await expect(rename).toBeVisible();
  await rename.getByLabel("Terminal name").fill("Renamed QA terminal");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(rename).not.toBeVisible();
  await expect(tab(initial[2])).toHaveText("Renamed QA terminal");
  await unchangedConnections();

  const beforeOpenFiles = await page.evaluate(() => window.fixture.calls.length);
  await paletteAction("Open SFTP file manager");
  const remoteChooser = page.locator('[data-file-side="remote"]').getByRole("button", { name: /^Remote server,/ });
  await expect(remoteChooser).toContainText("Renamed QA terminal");
  const remoteTargets = () => page.evaluate(start => window.fixture.calls.slice(start)
    .filter(call => call.args?.action === "file_list" && call.args.payload.side === "remote")
    .map(call => call.args.payload.sessionId), beforeOpenFiles);
  await expect.poll(async () => (await remoteTargets()).length).toBeGreaterThan(0);
  assert((await remoteTargets()).every((id) => id === initial[2]));
  await page.locator(".sidebar").getByRole("button", { name: "Terminal", exact: true }).click();
  await expect.poll(selected).toBe(initial[2]);
  await unchangedConnections();

  const captureDirectory = resolve(process.env.NEXSSH_TAB_CAPTURE || fileURLToPath(new URL("../../../work/", import.meta.url)));
  await mkdir(captureDirectory, { recursive: true });
  await page.setViewportSize({ width: 760, height: 560 });
  async function expectTheme(theme) {
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await expect.poll(() => page.evaluate(() => window.fixture.nativeTheme)).toBe(theme);
  }
  async function chooseTheme(theme) {
    await paletteAction("Open settings");
    await page.locator(".theme-options").getByRole("button", { name: theme[0].toUpperCase() + theme.slice(1), exact: true }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fixture.config.settings.theme)).toBe(theme);
  }
  const dragStyles = [];
  for (const theme of ["light", "dark"]) {
    await chooseTheme(theme);
    await expectTheme(theme);
    await page.locator(".sidebar").getByRole("button", { name: "Terminal", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(captureDirectory, `terminal-tabs-${theme}-760.png`) });
    await page.setViewportSize({ width: 1800, height: 900 });
    const beforeCapture = await order();
    const dragSource = tab(initial[1]);
    await startDrag(initial[1], initial[3], "after");
    await expect(page.locator(".terminal-tab-ghost")).toBeVisible();
    await expect(page.locator(".terminal-tab-gap")).toBeVisible();
    await expect.poll(order).toEqual(beforeCapture);
    const style = await page.evaluate(() => {
      const source = document.querySelector(".terminal-tab-ghost");
      const target = document.querySelector(".terminal-tab-gap");
      const stripBounds = source.closest('[role="tablist"]').getBoundingClientRect();
      const ghostBounds = source.getBoundingClientRect();
      return {
        bounded: ghostBounds.left >= stripBounds.left - 1 && ghostBounds.right <= stripBounds.right + 1 &&
          ghostBounds.top >= stripBounds.top - 1 && ghostBounds.bottom <= stripBounds.bottom + 1,
        text: getComputedStyle(source).color,
        background: getComputedStyle(source).backgroundColor,
        opacity: getComputedStyle(source).opacity,
        gapWidth: getComputedStyle(target).width,
        displacedTabs: [...document.querySelectorAll(".session-tab")].filter(tab => parseFloat(tab.style.getPropertyValue("--tab-preview-x")) !== 0).length,
      };
    });
    const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
      value /= 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(style.text);
    const background = luminance(style.background);
    const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    assert.equal(style.opacity, "1");
    assert.equal(style.bounded, true);
    assert(contrast >= 4.5, `${theme} dragged-tab contrast: ${contrast}`);
    assert(parseFloat(style.gapWidth) > 100);
    assert(style.displacedTabs > 0);
    await page.screenshot({ path: resolve(captureDirectory, `terminal-tab-drag-${theme}-1800.png`) });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(order).toEqual(beforeCapture);
    await dragSource.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(dragSource).toBeFocused();
    const focusStyle = await dragSource.evaluate((button) => ({ visible: button.matches(":focus-visible"), width: getComputedStyle(button).outlineWidth }));
    assert.equal(focusStyle.visible, true);
    assert(parseFloat(focusStyle.width) > 0);
    await page.screenshot({ path: resolve(captureDirectory, `terminal-tab-focus-${theme}-1800.png`) });
    dragStyles.push({ theme, contrast: Number(contrast.toFixed(2)), ...style, keyboardFocusVisible: true });
    await unchangedConnections();
    await page.setViewportSize({ width: 760, height: 560 });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await chooseTheme("system");
  await expectTheme("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme("light");
  const themeCallsBeforeContrast = await page.evaluate(() => window.fixture.calls.filter((call) => call.args?.action === "window_theme").length);
  await page.emulateMedia({ forcedColors: "active" });
  await expect.poll(() => page.evaluate(() => window.fixture.calls.filter((call) => call.args?.action === "window_theme").length)).toBeGreaterThan(themeCallsBeforeContrast);
  await expectTheme("light");
  await page.emulateMedia({ forcedColors: "none" });
  await expectTheme("light");
  await page.locator(".sidebar").getByRole("button", { name: "Terminal", exact: true }).click();
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect.poll(selected).toBe(initial[2]);
  await unchangedConnections();

  await page.getByRole("button", { name: "Close Renamed QA terminal", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(7);
  const closed = await page.evaluate((offset) => ({
    sessions: [...window.fixture.sessions.keys()],
    disconnects: window.fixture.calls.slice(offset).filter((call) => call.args?.action === "ssh_disconnect").map((call) => call.args.payload.sessionId),
    unwanted: window.fixture.calls.slice(offset).filter((call) => ["ssh_connect", "ssh_write"].includes(call.args?.action)).map((call) => call.args.action),
  }), baseline.calls);
  assert.deepEqual(closed.disconnects, [initial[2]]);
  assert.deepEqual(closed.unwanted, []);
  assert.deepEqual(closed.sessions, baseline.sessions.filter((id) => id !== initial[2]));
  return {
    internalSideBySideDropBothSides: true,
    invalidOrCancelledDropPreservesLayout: true,
    pointerLeftRight: true,
    escapeCancel: true,
    keyboardLeftRight: true,
    overflowAutoScroll: true,
    sessionAndXtermIdentityPreserved: true,
    splitPaneIdsAndPositionsPreserved: true,
    filesTargetPreserved: true,
    noConnectionOrCommandCallsDuringReorder: true,
    clickRenameAndClose: true,
    resolvedLightDarkSystemThemes: true,
    forcedColorsResync: true,
    narrowThemesWithoutPageOverflow: true,
    dragStyles,
  };
}
