import assert from "node:assert/strict";

export async function exercisePreviewEdit({ page, expect, firstId, clickOutput, writes, input }) {
  const path = "/edit-owner.cfg";
  await page.evaluate(({ id, path }) => {
    const f = window.fixture;
    const initial = Array.from({ length: 22 }, (_, index) => "row " + (index + 1)).join("\r\n") + "\r\n";
    f.editingFile = { content: initial, revision: "original" };
    f.emit("terminal-data", { sessionId: id, data: btoa("\r\n/edit-owner.cfg:17\r\n") });
    f.editSaves = [];
    f.editReads = 0;
    const transport = window.__TAURI_INTERNALS__;
    const original = transport.invoke.bind(transport);
    transport.invoke = async (cmd, args = {}) => {
      const { action, payload } = args;
      if (cmd !== "request" || !["file_preview_path", "file_read", "file_save"].includes(action))
        return original(cmd, args);
      if (payload.sessionId !== id || payload.side !== "remote" || payload.path !== path)
        throw new Error("Wrong preview session or file");
      if (action === "file_preview_path") { f.editReads++; return { kind: "file", path, ...f.editingFile }; }
      if (action === "file_read") return { ...f.editingFile };
      f.editSaves.push(payload);
      if (payload.revision !== f.editingFile.revision) throw new Error("File changed since it was opened.");
      if (f.pauseNextSave) {
        f.pauseNextSave = false;
        await new Promise(resolve => { f.finishEditSave = resolve; });
      }
      f.editingFile = { content: payload.content, revision: "saved" };
      return { revision: "saved", backupPath: path + ".bak" };
    };
  }, { id: firstId, path });
  await page.mouse.move(4, 4);
  await clickOutput(firstId, "edit-owner", true);
  const preview = page.getByRole("dialog", { name: "File preview", exact: true });
  await expect.poll(() => page.evaluate(() => window.fixture.editReads)).toBe(1);
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit file", exact: true });
  const content = editor.getByRole("textbox", { name: "Edit file contents" });
  await expect(content).toBeFocused();
  await expect(editor.locator(".cm-activeLine")).toHaveText("row 17");
  await page.keyboard.type("local ");
  await page.keyboard.press("Escape");
  await expect(editor.getByText("Discard unsaved changes?")).toBeVisible();
  await editor.getByRole("button", { name: "Keep editing" }).click();
  await expect(content).toBeFocused();
  await page.evaluate(() => {
    const f = window.fixture.editingFile;
    f.content = f.content.replace("row 17", "srv 17");
    f.revision = "server-1";
  });
  await page.keyboard.press("Control+s");
  await expect(editor.getByRole("region", { name: "On server" }).locator("pre")).toHaveText("srv 17");
  await expect(editor.getByRole("region", { name: "Your draft" }).locator("pre")).toHaveText("local row 17");
  await page.keyboard.press("Control+s");
  assert.equal(await page.evaluate(() => window.fixture.editSaves.length), 1);
  await page.evaluate(() => {
    const f = window.fixture.editingFile;
    f.content = f.content.replace("srv 17", "new 17");
    f.revision = "server-2";
  });
  const reviewedSave = editor.getByRole("button", { name: "Save reviewed draft" });
  await reviewedSave.click();
  await expect(editor.getByRole("region", { name: "On server" }).locator("pre")).toHaveText("new 17");
  await reviewedSave.click();
  await expect(editor.getByText("Saved with backup")).toBeVisible();
  const saved = await page.evaluate(() => window.fixture.editSaves);
  assert.deepEqual(saved.map(p => p.revision), ["original", "server-1", "server-2"]);
  assert.ok(saved.every(p => p.path === path && p.sessionId === firstId && p.side === "remote" && p.backup));
  assert.equal(saved[2].content,
    Array.from({ length: 22 }, (_, index) => (index === 16 ? "local " : "") + "row " + (index + 1)).join("\r\n") + "\r\n");
  await expect(content).toBeFocused();
  await page.keyboard.type("1");
  await page.evaluate(() => { window.fixture.pauseNextSave = true; });
  await page.keyboard.press("Control+s");
  await expect.poll(() => page.evaluate(() => typeof window.fixture.finishEditSave)).toBe("function");
  await page.keyboard.type("2");
  await page.evaluate(() => window.fixture.finishEditSave());
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(editor.getByText("Unsaved changes")).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(editor.getByText("Saved with backup")).toBeVisible();
  assert.match(await page.evaluate(() => window.fixture.editingFile.content), /local 12row 17/);
  await page.keyboard.press("Escape");
  await page.keyboard.type("t");
  await expect(input(firstId)).toBeFocused();
  await expect.poll(async () => (await writes()).at(-1)).toEqual({ sessionId: firstId, data: "t" });

  await page.mouse.move(4, 4);
  await clickOutput(firstId, "edit-owner", true);
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  await page.keyboard.type("throwaway ");
  await editor.getByRole("button", { name: "Close dialog" }).click();
  await editor.getByRole("button", { name: "Discard and return" }).click();
  await expect(input(firstId)).toBeFocused();
  assert.equal(await page.evaluate(() => window.fixture.editSaves.length), 5);
  await clickOutput(firstId, "edit-owner", true);
  await preview.getByRole("button", { name: "Edit", exact: true }).click();
  await page.keyboard.type("surviving draft ");
  await page.evaluate(id => window.fixture.emit("terminal-status", { sessionId: id, status: "disconnected" }), firstId);
  await expect(editor.getByText("This session is disconnected.", { exact: false })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(content).toContainText("surviving draft");
  await page.keyboard.press("Control+s");
  await page.evaluate(() => window.fixture.emit("tauri://close-requested", {}));
  const appClose = page.getByRole("dialog", { name: "Close NEXSSH?", exact: true });
  await expect(appClose.getByText(/Unsaved file edits will be discarded/)).toBeVisible();
  await expect(appClose.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(appClose).toHaveCount(0);
  await expect(content).toContainText("surviving draft");
  await expect(editor.getByText("Discard unsaved changes?")).toHaveCount(0);
  await editor.getByRole("button", { name: "Back to terminal" }).click();
  await editor.getByRole("button", { name: "Discard and return" }).click();
  await expect(editor).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.fixture.editSaves.length), 5);
  return { clickedLineEdited: true, backup: true, verifiedTwoConflicts: true,
    crlfPreserved: true, typingDuringSave: true, unsavedGuard: true, shellFocus: true,
    disconnectedDraftPreserved: true, nativeCloseEscape: true };
}
