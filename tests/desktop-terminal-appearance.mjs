import assert from "node:assert/strict";

const palettes = ["midnight", "graphite", "paper", "forest", "dusk"];
const fonts = ["JetBrains Mono", "IBM Plex Mono"];
const sample = "\x1b[2J\x1b[H\x1b[31mi\x1b[32mW\x1b[0m plain \x1b[38;2;70;160;230mRGB\x1b[0m";
const colorsOf = element => element.evaluate(node => {
  const style = getComputedStyle(node);
  return { foreground: style.color, background: style.backgroundColor };
});

export async function exerciseTerminalAppearance({page, expect, fixture, nav}) {
  const button = (name, root = page) => root.getByRole("button", {name, exact:true});
  const field = (name, root = page) => root.getByLabel(name, {exact: !["Terminal color theme", "Terminal font"].includes(name)});
  const preview = page.getByRole("group", {name:"Terminal preview", exact:true});
  const save = button("Save changes");
  const hex = field("Text color (hex)");
  const ssh = page.locator(".terminal-pane.focused:visible");
  const serial = page.getByRole("region", {name:"Serial terminal COM7"});
  const openSettings = async () => {
    await nav("Settings").click();
    await button("Terminal", page.getByRole("navigation", {name:"Settings categories"})).click();
  };
  async function saveSettings() {
    const previous = await page.evaluate(() => fixture.calls.filter(c => c.args?.action === "state_save").length);
    await save.click();
    await expect.poll(() => page.evaluate(() => fixture.calls.filter(c => c.args?.action === "state_save").length)).toBe(previous + 1);
  }
  const transportCalls = () => page.evaluate(() => fixture.calls
    .filter(c => ["ssh_connect", "ssh_disconnect", "serial_open", "serial_close"].includes(c.args?.action))
    .map(c => c.args.action));

  await expect(page.getByRole("heading", {name:"Your hosts"})).toBeVisible();
  await button(fixture.state_load.hosts[0].name, page.locator(".connections-grid")).click();
  const restore = button("Restore layout");
  await expect(restore).toBeVisible();
  await restore.click();
  const id = await ssh.getAttribute("data-session-id");
  await expect(ssh.locator(".xterm-rows")).toContainText("fixture$");
  await page.evaluate(({id, sample}) => fixture.emit("terminal-data", {sessionId:id, data:btoa(sample)}), {id, sample});

  await nav("Serial").click();
  await button("New serial session").click();
  const dialog = page.getByRole("dialog");
  await field("Serial port", dialog).selectOption({label:"COM7"});
  await button("Connect", dialog).click();
  await expect(serial.getByRole("status")).toHaveText("Connected");
  await page.evaluate(sample => fixture.emit("serial-data", {id:fixture.serialPort, data:btoa(sample)}), sample);
  await expect(serial.locator(".xterm-rows")).toContainText("iW plain RGB");
  const initialCalls = await transportCalls();

  async function verifyScreen(view, font, palette) {
    await nav(view).click();
    const pane = view === "Terminal" ? ssh : serial.locator(".serial-xterm");
    const rows = pane.locator(".xterm-rows");
    await expect(rows).toContainText("iW plain RGB");
    await expect(rows).toHaveCSS("font-family", new RegExp(font));
    await expect(rows).toHaveCSS("color", palette.foreground);
    await expect(pane).toHaveCSS("background-color", palette.background);
    const red = rows.locator(".xterm-fg-1").first();
    const green = rows.locator(".xterm-fg-2").first();
    await expect(red).toHaveText("i");
    await expect(green).toHaveText("W");
    await expect(red).not.toHaveCSS("color", palette.foreground);
    await expect(green).not.toHaveCSS("color", (await colorsOf(red)).foreground);
    await expect(rows.locator("span").filter({hasText:"RGB"}).first()).toHaveCSS("color", "rgb(70, 160, 230)");
    const first = await red.boundingBox();
    const second = await green.boundingBox();
    assert(first && second && first.width > 0);
    expect(second.width).toBeCloseTo(first.width, 1);
    expect(second.x - first.x).toBeCloseTo(first.width, 1);
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    return { red:(await colorsOf(red)).foreground, green:(await colorsOf(green)).foreground };
  }

  const backgrounds = new Set();
  const observed = new Map();
  for (const [index, palette] of palettes.entries()) {
    await openSettings();
    await field("Terminal color theme").selectOption(palette);
    const font = fonts[index % fonts.length];
    await field("Terminal font").selectOption({label:font});
    const colors = await colorsOf(preview);
    await saveSettings();
    const ansi = await verifyScreen("Terminal", font, colors);
    assert.deepEqual(await verifyScreen("Serial", font, colors), ansi);
    const faces = await page.evaluate(async name => {
      await document.fonts.ready;
      return Array.from(document.fonts).filter(face => face.family.replace(/["']/g,"") === name && face.status === "loaded").length;
    }, font);
    assert(faces > 0, font + " must use a loaded web font on this machine");
    backgrounds.add(colors.background);
    observed.set(palette, {colors, ansi});
  }
  assert.equal(backgrounds.size, palettes.length, "all five backgrounds must be distinct");

  await openSettings();
  await hex.fill("#XYZ");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await expect(save).toBeDisabled();
  await hex.fill("#8FE388");
  const custom = await colorsOf(preview);
  assert.equal(custom.foreground, "rgb(143, 227, 136)");
  await saveSettings();
  for (const view of ["Terminal", "Serial"]) {
    assert.deepEqual(await verifyScreen(view, fonts[0], custom), observed.get("dusk").ansi);
  }

  // Set a profile on an already open SSH tab, then verify the serial terminal keeps its global colors.
  await openSettings();
  await button("New profile").click();
  await field("Profile name", dialog).fill("Lab profile");
  await field("Font family", dialog).fill(fonts[1]);
  await field("Terminal color theme", dialog).selectOption("paper");
  const profileHex = field("Text color (hex)", dialog);
  await profileHex.fill("#112233");
  await button("Save profile", dialog).click();
  await nav("Terminal").click();
  await button("More terminal actions").click();
  await page.getByRole("menuitem", {name:/^Appearance/}).press("ArrowRight");
  await page.getByRole("menuitemradio", {name:"Lab profile", exact:true}).press("Enter");
  const paper = observed.get("paper");
  const override = {background:paper.colors.background, foreground:"rgb(17, 34, 51)"};
  assert.deepEqual(await verifyScreen("Terminal", fonts[1], override), paper.ansi);
  assert.deepEqual(await verifyScreen("Serial", fonts[0], custom), observed.get("dusk").ansi);

  await openSettings();
  await button("Edit Lab profile").click();
  await button("Use workspace text color", dialog).click();
  await button("Save profile", dialog).click();
  await verifyScreen("Terminal", fonts[1], {...override, foreground:custom.foreground});
  await openSettings();
  await button("Reset to theme color").click();
  await saveSettings();
  await verifyScreen("Terminal", fonts[1], paper.colors);
  await verifyScreen("Serial", fonts[0], observed.get("dusk").colors);
  assert.deepEqual(await transportCalls(), initialCalls, "editing appearance must not change either connection");

  await openSettings();
  await field("Pick text color").fill("#abcdef");
  await saveSettings();
  await page.reload();
  await openSettings();
  assert.equal((await hex.inputValue()).toLowerCase(), "#abcdef");
  await expect(field("Terminal color theme")).toHaveValue("dusk");
  await expect(field("Terminal font")).toHaveValue(fonts[0]);
  await button("Edit Lab profile").click();
  await expect(field("Font family", dialog)).toHaveValue(fonts[1]);
  await expect(field("Terminal color theme", dialog)).toHaveValue("paper");
  return {palettes, fonts, renderers:["ssh", "serial"], savedColor:true, profileInheritance:true, unchangedTransports:true};
}
