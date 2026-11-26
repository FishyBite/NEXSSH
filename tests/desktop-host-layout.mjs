import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function prepareHostLayout(fixture) {
  const state = fixture.state_load;
  state.settings.sidebarCollapsed = true;
  state.settings.restoreWorkspace = true;
  for (const host of state.hosts) {
    delete host.environmentLabel;
    host.favorite = false;
  }
  const rfs = state.hosts.find(host => host.name === "RFS");
  fixture.restoredWorkspace = {
    version: 1, workspaceId: rfs.workspaceId, view: "Hosts", activeTabId: "rfs-tab",
    tabs: [{ tabId: "rfs-tab", hostId: rfs.id, name: "RFS · 2" }],
  };
  fixture.transfer_list = ["audit.log", "audit.log", "integration-checklist.txt"].map((name, index) => ({
    id: "completed-" + index, sessionId: rfs.id, direction: index === 2 ? "upload" : "download",
    protocol: "sftp", source: "/test/" + name, destination: "/downloads/", status: "completed",
    totalBytes: 64, transferredBytes: 64, speedBytesPerSecond: 0, etaSeconds: null, startedAt: index + 1,
  }));
}

function measure() {
  const page = document.querySelector(".hosts-page");
  const sidebar = document.querySelector(".sidebar");
  const nav = sidebar.querySelector("nav");
  const sections = [".page-header", ".list-controls", ".connections-grid", ".recent-transfer-summary"]
    .map(selector => page.querySelector(selector).getBoundingClientRect());
  const cards = [...page.querySelectorAll(".connection-card")].map(card => card.getBoundingClientRect());
  const message = document.querySelector(".statusbar").textContent;
  return {
    viewport: innerWidth,
    columns: new Set(cards.map(rect => Math.round(rect.left))).size,
    leftEdges: sections.map(rect => Math.round(rect.left)),
    rightEdges: sections.map(rect => Math.round(rect.right)),
    buttonRight: Math.round(page.querySelector(".page-header .toolbar button:last-child").getBoundingClientRect().right),
    cardHeight: Math.max(...cards.map(rect => Math.round(rect.height))),
    cardsFit: cards.every(rect => rect.left >= sidebar.getBoundingClientRect().right && rect.right <= innerWidth),
    overflow: Math.max(document.documentElement.scrollWidth - innerWidth, page.scrollWidth - page.clientWidth),
    navOverflow: nav.scrollHeight - nav.clientHeight,
    status: message,
    staleHost: message.includes("RFS · 2") || !!document.querySelector(".active-connection")?.textContent.includes("RFS · 2"),
  };
}

export async function exerciseHostLayout({ page, expect, nav, directory }) {
  const hosts = page.locator(".hosts-page");
  await expect(hosts.locator(".connection-card")).toHaveCount(5);
  await expect(hosts.locator(".recent-transfer-summary li")).toHaveCount(3);
  await expect(page.locator(".statusbar")).toContainText(/0 active (?:SSH )?sessions/);
  await page.evaluate(() => document.fonts.ready);
  const layouts = [];
  for (const [width, height] of [[1536, 792], [1024, 720], [760, 560]]) {
    for (const compact of [true, false]) {
      await page.setViewportSize({ width, height });
      const toggle = nav(compact ? "Collapse sidebar" : "Expand sidebar");
      if (await toggle.isVisible()) await toggle.click();
      await expect(nav(compact ? "Expand sidebar" : "Collapse sidebar")).toBeVisible();
      await page.mouse.move(width - 4, height - 4);
      await hosts.getByRole("heading", { name:"Your hosts" }).scrollIntoViewIfNeeded();
      const info = await page.evaluate(measure);
      layouts.push({width, height, compact, ...info});
      if (directory) await page.screenshot({
        path:resolve(directory, `hosts-${width}-${compact ? "compact" : "expanded"}.png`), animations:"disabled",
      });
    }
  }
  if (directory) await writeFile(resolve(directory,"layout.json"), JSON.stringify(layouts, null, 2));
  for (const info of layouts) {
    const context = JSON.stringify(info);
    assert(Math.max(...info.rightEdges) - Math.min(...info.rightEdges) <= 2, context);
    assert(Math.max(...info.leftEdges) - Math.min(...info.leftEdges) <= 2, context);
    assert(info.overflow <= 1 && info.cardsFit && !info.staleHost, context);
    if (info.width === 1536 && info.compact) {
      assert(info.columns >= 4 && info.cardHeight <= 140, context);
      assert(Math.abs(info.buttonRight - info.rightEdges[2]) <= 2, context);
      assert(info.navOverflow <= 1, context);
    }
  }
  await hosts.getByRole("button", { name: "New group", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New server group" })).toBeVisible();
  await page.keyboard.press("Escape");
  await hosts.getByRole("button", { name: "Actions for RFS" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit host" })).toBeVisible();
  await page.keyboard.press("Escape");
  await hosts.getByRole("textbox", { name: "Search hosts" }).fill("RFS");
  await expect(hosts.locator(".connection-card")).toHaveCount(1);
  await hosts.getByRole("textbox", { name: "Search hosts" }).fill("");
  await hosts.getByRole("button", { name: "View history" }).click();
  await expect(nav("Transfers")).toHaveAttribute("aria-current", "page");
  await nav("Hosts").click();
  await hosts.getByRole("button", { name: "OpenShift", exact: true }).click();
  await expect(page.getByRole("tab", {name: "OpenShift", exact: true})).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", {name: "RFS · 2", exact: true})).toBeAttached();
  return { checkedHostLayouts: layouts.length, controls: "passed", savedTabHiddenOutsideSession: true };
}
