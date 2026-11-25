import assert from "node:assert/strict";

export async function exerciseWindowScroll({page, expect, nav}) {
  const main = page.locator("main.workspace");
  const history = main.getByRole("button", {name:"View history",exact:true});
  const rail = page.getByRole("navigation",{name:"Main navigation"});
  const cdp = await page.context().newCDPSession(page);
  const geometry = () => page.evaluate(() => {
    const root = document.scrollingElement;
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    return {
      documentY: root.scrollTop, documentX: root.scrollLeft, width: root.scrollWidth, height: root.scrollHeight,
      viewportWidth: innerWidth, viewportHeight: innerHeight, footerBottom: rect(".statusbar").bottom,
      headerTop: rect(".topbar").top, shellLeft: rect(".app-shell").left, sidebarBottom: rect(".sidebar").bottom,
    };
  });
  async function checkChrome() {
    const g = await geometry();
    assert.ok(g.documentX === 0 && g.documentY === 0 && g.width <= g.viewportWidth + 1 && g.height <= g.viewportHeight + 1 &&
      Math.abs(g.footerBottom - g.viewportHeight) <= 1 && Math.abs(g.sidebarBottom - g.viewportHeight) <= 1 &&
      Math.abs(g.headerTop) <= 1 && Math.abs(g.shellLeft) <= 1, JSON.stringify(g));
  }
  await nav("Hosts").click();
  await expect(main.getByRole("heading",{name:"Your hosts"})).toBeVisible();
  // Portals and off-screen measurement nodes can extend the document below the shell.
  // Even with one of these present, the footer must be pinned and the page must not pan.
  await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;top:calc(100% + 64px);height:1px;width:1px;pointer-events:none";
    probe.setAttribute("aria-hidden","true");
    document.body.appendChild(probe);
  });
  for (const [width,height,scale] of [[1536,790,1.25],[760,560,1],[680,430,1.5]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:scale,mobile:false});
    await main.evaluate(el => el.scrollTop = 0);
    const area = await main.boundingBox();
    await page.mouse.move(area.x+area.width/2,area.y+area.height/2);
    await page.mouse.wheel(0,12000);
    await expect.poll(() => main.evaluate(el => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2 && el.scrollTop > 0)).toBe(true);
    await expect(history).toBeInViewport();
    await page.mouse.wheel(0,12000);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await checkChrome();
    if (width === 1536 && process.env.VEXSSH_SCROLL_CAPTURE)
      await page.screenshot({path:process.env.VEXSSH_SCROLL_CAPTURE,animations:"disabled"});
    const atBottom = await main.evaluate(el => el.scrollTop);
    const navBounds = await rail.boundingBox();
    await page.mouse.move(navBounds.x+navBounds.width/2,navBounds.y+navBounds.height/2);
    await page.mouse.wheel(0,12000);
    await page.mouse.wheel(0,12000);
    await expect(rail.getByRole("button",{name:"Tunnels",exact:true})).toBeInViewport();
    assert.equal(await main.evaluate(el => el.scrollTop), atBottom);
    await checkChrome();
    await main.getByRole("textbox",{name:"Search hosts"}).focus();
    await expect(main.getByRole("textbox",{name:"Search hosts"})).toBeInViewport();
    await history.focus();
    await page.keyboard.press("End");
    await expect(history).toBeInViewport();
    await page.evaluate(() => window.scrollTo(99999,99999));
    await checkChrome();
  }
  await nav("Switch to light mode").click();
  await page.emulateMedia({reducedMotion:"reduce"});
  await nav("Expand sidebar").click();
  await expect(nav("Collapse sidebar")).toBeVisible();
  await checkChrome();
  await history.click();
  await expect(nav("Transfers")).toHaveAttribute("aria-current","page");
  await checkChrome();
  await cdp.detach();
  return {scrollToEnd:true,keyboardFocus:true,independentSidebar:true,dpi:[100,125,150],themes:["dark","light"]};
}
