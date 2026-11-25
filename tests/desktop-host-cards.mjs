import assert from "node:assert/strict";
import { resolve } from "node:path";

export async function exerciseHostCards({page, expect, fixture, nav, directory}) {
  const [first, second] = fixture.state_load.hosts;
  const sidebar = page.locator(".sidebar");
  const hostGrid = page.locator(".hosts-page .connections-grid");
  const open = name => hostGrid.getByRole("button", {name, exact:true});
  const menu = name => open("Actions for " + name);
  const attempts = () => page.evaluate(() => window.fixture.calls.filter(call => call.args?.action === "ssh_connect").length);
  const start = await attempts();
  await page.setViewportSize({width:1380,height:900});
  await nav("Hosts").click();
  await expect(nav("Hosts")).toHaveAttribute("aria-current","page");
  await expect(hostGrid.locator("article")).toHaveCount(fixture.state_load.hosts.length);
  const checkFit = () => page.evaluate(() => {
    const main = document.querySelector(".hosts-page");
    const sidebar = document.querySelector(".sidebar");
    const hostGrid = main.querySelector(".connections-grid").getBoundingClientRect();
    const rectangles = [...main.querySelectorAll(".connection-card")].map(card => card.getBoundingClientRect());
    return {body:document.documentElement.scrollWidth, viewport:innerWidth, content:main.scrollWidth,
      main:main.clientWidth, columns:new Set(rectangles.map(r => Math.round(r.left))).size,
      fits:rectangles.every(r => r.left >= sidebar.getBoundingClientRect().right && r.right <= innerWidth && r.right <= hostGrid.right + 1)};
  });
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  let fit = await checkFit();
  assert(fit.fits && fit.body === fit.viewport && fit.content <= fit.main && fit.columns >= 2, JSON.stringify(fit));
  if (directory) await page.screenshot({path:resolve(directory,"vexssh-hosts-dark.png"),animations:"disabled"});

  await open(second.name).focus();
  await page.keyboard.press("Tab");
  await expect(menu(second.name)).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem",{name:"Add favorite"}).press("Enter");
  await expect.poll(() => page.evaluate(id => window.fixture.config.hosts.find(host => host.id === id).favorite, second.id)).toBe(true);
  await expect(menu(second.name)).toBeFocused();
  await nav("Favorites").press("Enter");
  await expect(open(second.name)).toBeVisible();
  await nav("Hosts").press("Enter");
  await menu(second.name).press("Enter");
  await page.getByRole("menuitem",{name:"Select host"}).press("Enter");
  const checkbox = name => hostGrid.getByRole("checkbox",{name:"Select " + name, exact:true});
  await expect(checkbox(second.name)).toBeChecked();
  await checkbox(first.name).press("Space");
  await expect(page.locator(".selection-bar")).toContainText("2 selected");
  await page.getByRole("button",{name:"Clear",exact:true}).press("Enter");
  await expect(page.locator(".selection-bar")).toHaveCount(0);
  await menu(second.name).press("Enter");
  await page.keyboard.press("Escape");
  await expect(menu(second.name)).toBeFocused();
  assert.equal(await attempts(), start, "Favorite, select and dismiss must not start an SSH connection");

  await nav("Switch to light mode").click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.setViewportSize({width:760,height:650});
  fit = await checkFit();
  assert(fit.fits && fit.body === fit.viewport && fit.content <= fit.main, JSON.stringify(fit));
  await nav("Collapse sidebar").click();
  await expect(nav("Expand sidebar")).toBeVisible();
  await page.getByRole("button",{name:"Switch workspace",exact:true}).press("Enter");
  await expect(page.getByRole("menuitemradio",{name:fixture.state_load.workspaces[0].name})).toHaveAttribute("aria-checked","true");
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"Quick connect",exact:true}).press("Enter");
  await expect(page.getByRole("dialog",{name:"Quick connect"})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await open(second.name).focus();
  await page.mouse.move(755,640);
  await page.evaluate(() => {document.querySelector(".sidebar").scrollTop=0; document.activeElement?.blur();});
  fit = await checkFit();
  assert(fit.fits && fit.body === fit.viewport && fit.content <= fit.main, JSON.stringify(fit));
  if (directory) await page.screenshot({path:resolve(directory,"vexssh-hosts-light-narrow.png"),animations:"disabled"});
  assert.equal(await attempts(), start);
  await open(second.name).press("Enter");
  await expect.poll(attempts).toBe(start + 1);
  await expect(page.getByRole("tab",{name:second.name,exact:true})).toHaveAttribute("aria-selected","true");
  return {darkDesktop:true, lightMinWidth:true, keyboardConnectsOnce:true, menuAndSelectionNoSSH:true};
}
