import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const palettes = JSON.parse(await readFile(new URL("../src/appThemes.json", import.meta.url), "utf8"));
const toRgb = hex => {
  const digits = hex.length === 4 ? [...hex.slice(1)].map(digit => digit + digit).join("") : hex.slice(1);
  return "rgb(" + digits.match(/../g).map(x => parseInt(x, 16)).join(", ") + ")";
};

function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
    .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

function contrast(a, b) {
  const [lower, higher] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (higher + .05) / (lower + .05);
}

export async function exerciseAppThemes({ page, expect, nav }) {
  const html = page.locator("html");
  const choices = page.getByRole("group", { name: "Application theme" });
  const button = (name, root = page) => root.getByRole("button", { name, exact: true });
  const openSettings = () => nav("Settings").click();
  const apiTheme = () => page.evaluate(() => fixture.nativeTheme);
  const category = name => button(name, page.getByRole("navigation", { name: "Settings categories" }));
  const checkTheme = async id => {
    const { background, foreground, scheme } = palettes[id];
    await expect(html).toHaveAttribute("data-app-theme", id);
    await expect(html).toHaveAttribute("data-theme", scheme);
    await expect(html).toHaveCSS("background-color", toRgb(background));
    await expect(html).toHaveCSS("color", toRgb(foreground));
    await expect(html).toHaveCSS("color-scheme", scheme);
    await expect.poll(apiTheme).toBe(id);
  };
  const custom = ["midnight", "graphite", "forest", "dusk", "paper", "mist"];
  const observed = new Set();
  await openSettings();
  await expect(choices.getByRole("button")).toHaveCount(9);

  for (const id of ["dark", "light", ...custom]) {
    const { label } = palettes[id];
    const tile = button(label, choices);
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await button("Save changes").click();
    await checkTheme(id);
    const tokens = await html.evaluate(node => {
      const style = getComputedStyle(node);
      const names = ["text", "muted", "accent", "accent-text", "input-border", "error", "success", "warning",
        "bg", "sidebar", "card", "elevated", "hover", "selection"];
      return Object.fromEntries(names.map(name => [name, style.getPropertyValue("--" + name).trim()]));
    });
    if (custom.includes(id)) {
      for (const color of ["text", "muted", "accent-text", "error", "success", "warning"]) {
        for (const surface of ["bg", "sidebar", "card", "elevated", "hover", "selection"]) {
          assert(contrast(tokens[color], tokens[surface]) >= 4.5, [id, color, surface].join(" / "));
        }
      }
      assert(contrast(tokens["input-border"], tokens.bg) >= 3);
      await expect(tile.locator(".theme-swatch")).toHaveCSS("background-color", toRgb(tokens.bg));
      await expect(tile.locator(".theme-swatch i").first()).toHaveCSS("background-color", toRgb(tokens.accent));
      observed.add(tokens.bg);
    }
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", toRgb(tokens.sidebar));
    await nav("Hosts").click();
    await expect(page.locator(".connection-card").first()).toHaveCSS("background-color", toRgb(tokens.card));
    await nav("Files").click();
    await expect(page.locator(".file-pane:visible").first()).toHaveCSS("background-color", toRgb(tokens.card));
    await nav("Databases").click();
    await expect(button("New connection")).toHaveCSS("background-color", toRgb(tokens.accent));
    await nav("Serial").click();
    await button("New serial session").click();
    await expect(page.getByRole("dialog")).toHaveCSS("background-color", toRgb(tokens.card));
    await button("Cancel", page.getByRole("dialog")).click();
    await openSettings();
  }
  assert.equal(observed.size, custom.length);
  await page.reload();
  await checkTheme("mist");
  await openSettings();
  await expect(button("Mist", choices)).toHaveAttribute("aria-pressed", "true");
  await button("Terminal colors and fonts").click();
  await expect(category("Terminal")).toBeFocused();
  await expect(page.getByLabel("Terminal color theme")).toBeVisible();
  await category("Appearance").click();

  await page.emulateMedia({ colorScheme: "dark" });
  await button("System", choices).click();
  await button("Save changes").click();
  await checkTheme("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await checkTheme("light");
  await expect(button("System", choices)).toHaveAttribute("aria-pressed", "true");
  const viewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 680, height: 760 });
    const width = await choices.evaluate(n => [n.clientWidth, n.scrollWidth]);
    assert(width[1] <= width[0] + 1, "Theme chooser should fit the viewport");
    await expect(choices.getByRole("button")).toHaveCount(9);
  } finally {
    await page.setViewportSize(viewport);
  }
  return { choices: 9, custom, systemSchemes: ["dark", "light"], persisted: "mist",
    surfaces: ["Sidebar", "Hosts", "Files", "Databases", "Serial"] };
}
