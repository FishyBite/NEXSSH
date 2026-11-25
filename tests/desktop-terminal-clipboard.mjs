export async function exerciseTerminalClipboard({ page, expect, fixture, paletteAction }) {
  const sessionView = page.getByRole("group", { name: "Session view", exact: true });
  await sessionView.getByRole("button", { name: "Terminal", exact: true }).click();
  const pane = page.locator(".terminal-pane:visible");
  const input = pane.locator(".xterm-helper-textarea");
  const screen = pane.locator(".xterm-screen");
  const sessionId = await pane.getAttribute("data-session-id");
  const setClipboard = text => page.evaluate(value => { window.fixture.clipText = value; }, text);
  const getClipboard = () => page.evaluate(() => window.fixture.clipText);
  const readSession = id => page.evaluate(id => window.fixture.calls
    .filter(call => call.args?.action === "ssh_write" && call.args.payload.sessionId === id)
    .map(call => call.args.payload.data).join(""), id);
  const readInput = () => readSession(sessionId);
  await page.evaluate(() => {
    window.fixture.clipReads = 0;
    window.fixture.clipWrites = [];
    const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "request" && args?.action === "clipboard_write_text") {
        window.fixture.clipWrites.push(args.payload.text);
        window.fixture.clipText = args.payload.text;
        return;
      }
      if (command === "request" && args?.action === "clipboard_read_text") {
        window.fixture.clipReads++;
        if (window.fixture.failRead) {
          window.fixture.failRead = false;
          throw new Error("Clipboard unavailable");
        }
        const text = window.fixture.clipText;
        if (window.fixture.holdRead) {
          window.fixture.holdRead = false;
          await new Promise(resolve => { window.fixture.finishRead = resolve; });
          delete window.fixture.finishRead;
        }
        return text;
      }
      return invoke(command, args);
    };
  });

  // The fixture terminal displays "fixture$ ". Selecting the first word exercises
  // xterm's real selection, which is independent of the browser DOM selection.
  const word = { x: 16, y: 7 };
  const selectWord = () => screen.dblclick({ position: word });
  const readCount = () => page.evaluate(() => window.fixture.clipReads);
  const rightPaste = () => screen.click({ button: "right", position: word });
  const menu = async name => {
    await screen.click({ button: "right", modifiers: ["Shift"], position: word });
    await pane.getByRole("button", { name, exact: true }).click();
  };
  let expected = "";
  const bracketed = text => "\x1b[200~" + text + "\x1b[201~";
  await setClipboard("café / 端末");
  await rightPaste();
  await page.keyboard.type("x");
  expected += bracketed("café / 端末") + "x";
  await expect.poll(readInput).toBe(expected);
  await expect(input).toBeFocused();
  await expect(pane.getByRole("button", {name: "Paste", exact: true})).toHaveCount(0);
  await expect.poll(readCount).toBe(1);

  await setClipboard("before selecting a word");
  await selectWord();
  await expect.poll(getClipboard).toBe("fixture$");
  await setClipboard("before menu copy");
  await menu("Copy selection");
  await expect.poll(getClipboard).toBe("fixture$");
  await expect.poll(readCount).toBe(1);
  await page.keyboard.type("y");
  expected += "y";
  await expect.poll(readInput).toBe(expected);
  await setClipboard("menu paste");
  await menu("Paste");
  expected += bracketed("menu paste");
  await expect.poll(readInput).toBe(expected);
  await expect.poll(readCount).toBe(2);

  for (const key of ["Control+c", "Control+Shift+c"]) {
    await setClipboard("");
    await selectWord();
    await page.keyboard.press(key);
    await expect.poll(getClipboard).toBe("fixture$");
    await page.keyboard.type("z");
    expected += "z";
    await expect.poll(readInput).toBe(expected);
  }
  await screen.click({ position: { x: 120, y: 7 } });
  await page.keyboard.press("Control+c");
  expected += "\x03";
  await expect.poll(readInput).toBe(expected);

  for (const key of ["Control+v", "Control+Shift+v"]) {
    await setClipboard("Ω\r\nパ");
    await page.keyboard.press(key);
    await page.keyboard.type("t");
    expected += bracketed("Ω\rパ") + "t";
    await expect.poll(readInput).toBe(expected);
    await expect(input).toBeFocused();
  }

  // A clipboard manager may supply text asynchronously. Typing immediately after
  // the click must still produce paste-then-key, in exactly that order.
  await setClipboard("slow");
  await page.evaluate(() => { window.fixture.holdRead = true; });
  await rightPaste();
  await expect.poll(() => page.evaluate(() => typeof window.fixture.finishRead)).toBe("function");
  await page.keyboard.type("q");
  await page.evaluate(() => window.fixture.finishRead());
  expected += bracketed("slow") + "q";
  await expect.poll(readInput).toBe(expected);

  await input.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "browser");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });
  await page.keyboard.type("d");
  expected += bracketed("browser") + "d";
  await expect.poll(readInput).toBe(expected);

  await page.evaluate(() => { window.fixture.failRead = true; });
  await rightPaste();
  await page.keyboard.type("e");
  expected += "e";
  await expect.poll(readInput).toBe(expected);
  await expect(input).toBeFocused();

  // Expanded terminals hide the sidebar used to navigate away during the deferred read.
  const restoreLayout = page.getByRole("button", { name: "Restore layout", exact: true });
  if (await restoreLayout.isVisible()) await restoreLayout.click();
  await page.evaluate(() => { window.fixture.holdRead = true; });
  await setClipboard("stale");
  await rightPaste();
  await expect.poll(() => page.evaluate(() => typeof window.fixture.finishRead)).toBe("function");
  await page.locator(".sidebar").getByRole("button", { name: "Hosts", exact: true }).click();
  await page.evaluate(() => window.fixture.finishRead());
  await expect(page.getByRole("heading", { name: "Your hosts", exact: true })).toBeVisible();
  await expect(page.locator(".xterm-helper-textarea:focus")).toHaveCount(0);
  await page.locator(".sidebar").getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(input).toBeFocused();
  await page.keyboard.type("r");
  expected += "r";
  await expect.poll(readInput).toBe(expected);

  await selectWord();
  await page.keyboard.press("Control+c");
  await expect.poll(getClipboard).toBe("fixture$");
  await paletteAction(fixture.state_load.hosts[1].name);
  await expect(page.getByRole("tab")).toHaveCount(2);
  const secondId = await pane.getAttribute("data-session-id");
  expect(secondId).not.toBe(sessionId);
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+v");
  await page.keyboard.type("b");
  const secondExpected = bracketed("fixture$") + "b";
  await expect.poll(() => readSession(secondId)).toBe(secondExpected);
  await expect.poll(readInput).toBe(expected);

  // Return to the same pane before the read resolves. A focus equality check
  // alone would let the old paste through after this round trip.
  await page.evaluate(() => { window.fixture.holdRead = true; });
  await page.keyboard.press("Control+v");
  await expect.poll(() => page.evaluate(() => typeof window.fixture.finishRead)).toBe("function");
  const tabs = page.getByRole("tab");
  await tabs.nth(0).click();
  await expect(pane).toHaveAttribute("data-session-id", sessionId);
  await tabs.nth(1).click();
  await expect(pane).toHaveAttribute("data-session-id", secondId);
  await expect(input).toBeFocused();
  await page.evaluate(() => window.fixture.finishRead());
  await page.keyboard.type("n");
  await expect.poll(() => readSession(secondId)).toBe(secondExpected + "n");
  await expect.poll(readInput).toBe(expected);
  await exerciseMouseCopy({ page, expect, screen, input, sessionId: secondId, readSession, getClipboard, setClipboard, paletteAction });
  const tools = page.getByRole("button", {name:"Terminal tools", exact:true});
  if (await tools.isVisible() && await tools.getAttribute("aria-expanded") === "false") await tools.click();
  await page.getByRole("button", {name:"Split terminal", exact:true}).click();
  await page.getByRole("menuitemradio", {name:"Split side by side"}).click();
  const firstPane = page.locator('.terminal-pane[data-session-id="' + sessionId + '"]');
  await expect(firstPane).toBeVisible();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  const secondBeforeSplitPaste = await readSession(secondId);
  await setClipboard("split pane");
  await firstPane.locator(".xterm-screen").click({button:"right", position:word});
  await page.keyboard.type("v");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(firstPane.locator(".xterm-helper-textarea")).toBeFocused();
  await expect.poll(readInput).toBe(expected + bracketed("split pane") + "v");
  await expect.poll(() => readSession(secondId)).toBe(secondBeforeSplitPaste);
  const bundle = await page.locator('script[type="module"][src]').first().getAttribute("src");
  return { bundle, rightClickPaste: true, shiftRightClickMenu: true, mouseReleaseCopies: true, pasteToInactiveSplit: true, contextMenuCopyPaste: true, keyboardCopyPaste: true, interruptPreserved: true,
    immediateTyping: true, pendingReadOrder: true, domPaste: true, expiredPasteDiscarded: true,
    terminalToTerminal: true, expiredAfterSwitchAndReturn: true, plainShellDrag: true,
    multilineTuiDrag: true, tuiClickAndInterruptPreserved: true };
}

async function exerciseMouseCopy({ page, expect, screen, input, sessionId, readSession, getClipboard, setClipboard, paletteAction }) {
  const output = text => page.evaluate(({ sessionId, text }) => {
    const bytes = new TextEncoder().encode(text);
    window.fixture.emit("terminal-data", { sessionId, data: btoa(String.fromCharCode(...bytes)) });
  }, { sessionId, text });
  const sent = () => readSession(sessionId);
  const row = index => screen.locator(".xterm-rows > div").nth(index);
  async function dragRows(lastRow, beforeRelease) {
    // Navigating back from Settings restores the terminal layout and refits its cells.
    // Wait for the row to settle before measuring the first and last pointer positions.
    await row(0).hover({position:{x:1,y:5}});
    await screen.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const first = await row(0).boundingBox();
    const last = await row(lastRow).boundingBox();
    await page.mouse.move(first.x + 1, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + 245, last.y + last.height / 2, { steps: 12 });
    if (beforeRelease) await beforeRelease();
    await page.mouse.up();
  }
  async function copySelected(text) {
    // Reset after selection to verify the actual key even with copy-on-select enabled.
    await setClipboard("unchanged clipboard");
    const before = await sent();
    await page.keyboard.press("Control+c");
    await expect.poll(async () => (await getClipboard()).replaceAll("\r\n", "\n")).toBe(text);
    await expect.poll(sent).toBe(before);
    await expect(input).toBeFocused();
  }

  // A TUI needs xterm's runtime stylesheet for both the character grid and ANSI colors.
  await output("\x1b[2J\x1b[H\x1b[31mi\x1b[32mW\x1b[0m  end");
  await expect(row(0)).toHaveText("iW  end");
  await expect(row(0)).toHaveCSS("white-space", "pre");
  await expect(row(0)).toHaveCSS("font-family", /Consolas/i);
  const narrow = row(0).locator(".xterm-fg-1").first();
  const wide = row(0).locator(".xterm-fg-2").first();
  await expect(narrow).toHaveCSS("color", "rgb(255, 100, 124)");
  await expect(wide).toHaveCSS("color", "rgb(53, 201, 138)");
  const narrowCell = await narrow.boundingBox();
  const wideCell = await wide.boundingBox();
  expect(narrowCell.width).toBeGreaterThan(0);
  expect(wideCell.width).toBeCloseTo(narrowCell.width, 1);

  await output("\x1b[2J\x1b[HShell output");
  await expect(row(0)).toHaveText("Shell output");
  await setClipboard("previous clipboard");
  const writes = () => page.evaluate(() => window.fixture.clipWrites.length);
  const beforeShellDrag = await writes();
  await dragRows(0, async () => {
    await expect.poll(getClipboard).toBe("previous clipboard");
    await expect.poll(writes).toBe(beforeShellDrag);
  });
  await expect.poll(getClipboard).toBe("Shell output");
  await expect.poll(writes).toBe(beforeShellDrag + 1);
  await copySelected("Shell output");
  await setClipboard("unrelated clipboard text");
  const beforeSearch = await writes();
  await input.focus();
  await page.keyboard.press("Control+Shift+f");
  const search = page.getByRole("textbox", { name: "Search terminal output" });
  await search.fill("output");
  await expect(screen.locator(".xterm-selection > div").first()).toBeVisible();
  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect.poll(writes).toBe(beforeSearch);
  await expect.poll(getClipboard).toBe("unrelated clipboard text");

  // TUIs can request click, button-motion, or all-motion reporting. Only ordinary
  // hover reports (SGR 35) may be sent while moving the pointer to the gesture.
  const withoutHover = data => data.replace(/\x1b\[<35;\d+;\d+M/g, "");
  await output("\x1b[?1049h\x1b[?1006h");
  for (const mode of [1000, 1002, 1003]) {
    const firstLine = "Jawaban " + mode;
    await output("\x1b[?" + mode + "h\x1b[2J\x1b[H" + firstLine + "\r\nBaris kedua: café\r\n");
    await expect(row(0)).toHaveText(firstLine);
    await expect(row(1)).toHaveText("Baris kedua: café");
    const beforeDrag = await sent();
    await dragRows(1);
    await expect.poll(async () => (await getClipboard()).replaceAll("\r\n", "\n")).toBe(firstLine + "\nBaris kedua: café");
    await copySelected(firstLine + "\nBaris kedua: café");
    await expect.poll(async () => withoutHover((await sent()).slice(beforeDrag.length))).toBe("");
  }

  // A genuine click should still reach the TUI as a matched button press/release.
  const beforeClick = await sent();
  await setClipboard("left click leaves clipboard alone");
  await row(2).click({ position: { x: 12, y: 5 } });
  await expect.poll(async () => withoutHover((await sent()).slice(beforeClick.length)))
    .toMatch(/^\x1b\[<0;(\d+);(\d+)M\x1b\[<0;\1;\2m$/);
  const beforeInterrupt = await sent();
  await page.keyboard.press("Control+c");
  await expect.poll(sent).toBe(beforeInterrupt + "\x03");
  await expect.poll(getClipboard).toBe("left click leaves clipboard alone");

  const readCount = () => page.evaluate(() => window.fixture.clipReads);
  const beforeRead = await readCount();
  const beforeRight = await sent();
  await setClipboard("Ω TUI paste");
  await row(1).click({button:"right", position:{x:16,y:5}});
  await page.keyboard.type("j");
  await expect.poll(async () => withoutHover((await sent()).slice(beforeRight.length)))
    .toBe("\x1b[200~Ω TUI paste\x1b[201~j");
  await expect.poll(readCount).toBe(beforeRead + 1);
  await expect(input).toBeFocused();

  await paletteAction("Open settings");
  await page.getByRole("navigation", { name:"Settings categories" }).getByRole("button", { name:"Terminal", exact:true }).click();
  const copyOnSelect = page.getByRole("checkbox", {name:"Automatically copy mouse selections"});
  await expect(copyOnSelect).toBeChecked();
  await copyOnSelect.uncheck();
  await page.getByRole("button", {name:"Save changes", exact:true}).click();
  await expect.poll(() => page.evaluate(() => window.fixture.config.settings.copyOnSelect)).toBe(false);
  await page.locator(".sidebar").getByRole("button", {name:"Terminal", exact:true}).click();
  await expect(input).toBeFocused();
  await setClipboard("auto copy disabled");
  const beforeDisabledDrag = await writes();
  await dragRows(1);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect.poll(getClipboard).toBe("auto copy disabled");
  await expect.poll(writes).toBe(beforeDisabledDrag);
  await copySelected("Jawaban 1003\nBaris kedua: café");
}
