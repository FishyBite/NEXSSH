import assert from "node:assert/strict";

export async function exerciseRecordingAndRates({ page, expect, nav }) {
  const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
  const openRates = async () => {
    await nav("Settings").click();
    await button("File transfer", page.getByRole("navigation", { name: "Settings categories" })).click();
  };
  const upload = page.getByRole("spinbutton", { name: "SFTP upload limit (KiB/s)" });
  const download = page.getByRole("spinbutton", { name: "SFTP download limit (KiB/s)" });
  const save = button("Save changes");
  await openRates();
  await expect(upload).toHaveValue("0");
  await expect(download).toHaveValue("0");
  for (const value of ["-1", "1.5", "1048577", ""]) {
    await upload.fill(value);
    await expect(save).toBeDisabled();
  }
  await upload.fill("96");
  await download.fill("192");
  await save.click();
  await expect.poll(() => page.evaluate(() => fixture.config.settings.sftpDownloadLimitKiB)).toBe(192);
  await page.reload();
  await openRates();
  await expect(upload).toHaveValue("96");
  await expect(download).toHaveValue("192");
  await upload.fill("0");
  await save.click();
  await expect.poll(() => page.evaluate(() => [fixture.config.settings.sftpUploadLimitKiB, fixture.config.settings.sftpDownloadLimitKiB])).toEqual([0,192]);

  await page.evaluate(() => {
    const api = window.__TAURI_INTERNALS__;
    const original = api.invoke.bind(api);
    fixture.recordRequests = [];
    fixture.savePrompts = 0;
    api.invoke = async (command, args) => {
      if (command === "plugin:dialog|save") {
        fixture.savePrompts++;
        return fixture.nextLogPath ?? null;
      }
      if (["serial_record_start", "serial_record_stop"].includes(args?.action)) {
        fixture.recordRequests.push({ action: args.action, ...args.payload });
        if (args.action === "serial_record_start" && fixture.rejectStart) throw Error("File already exists");
        return null;
      }
      return original(command,args);
    };
  });
  await nav("Serial").click();
  await button("New serial session").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Serial port", { exact:true }).selectOption("port:COM7");
  await button("Connect",dialog).click();
  const console = page.getByRole("region", { name:"Serial terminal COM7" });
  const record = button("Record log",console);
  const stop = button("Stop recording",console);
  const input = console.locator(".xterm-helper-textarea");
  await expect(record).toBeEnabled();
  await record.click();
  await expect.poll(() => page.evaluate(() => fixture.savePrompts)).toBe(1);
  await expect(record).toBeEnabled();
  assert.equal(await page.evaluate(() => fixture.recordRequests.length),0);
  await page.evaluate(() => { fixture.nextLogPath = "C:\\Fixture\\session.log"; fixture.rejectStart = true; });
  await record.click();
  await expect(console.getByRole("alert")).toContainText("File already exists");
  await expect(record).toBeEnabled();
  await page.evaluate(() => { fixture.rejectStart = false; });
  await record.click();
  await expect(stop).toBeEnabled();
  const capture = await page.evaluate(() => fixture.recordRequests.at(-1));
  assert.equal(capture.id, await page.evaluate(() => fixture.serialPort));
  assert.equal(capture.path,"C:\\Fixture\\session.log");
  assert.match(capture.recordingId,/^[a-f\d-]{36}$/i);
  await expect(input).toBeFocused();
  await nav("Hosts").click();
  await nav("Serial").click();
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(record).toBeEnabled();
  await expect(input).toBeFocused();
  const stopped = await page.evaluate(() => fixture.recordRequests.at(-1));
  assert.equal(stopped.id,capture.id);
  assert.equal(stopped.recordingId,capture.recordingId);
  await record.click();
  await expect(stop).toBeEnabled();
  await page.evaluate(old => fixture.emit("serial-record-error", { id: fixture.serialPort, recordingId: old, error:"stale capture" }), capture.recordingId);
  await expect(stop).toBeEnabled();
  await page.evaluate(() => fixture.emit("serial-record-error", { id: fixture.serialPort, recordingId: fixture.recordRequests.at(-1).recordingId, error:"Disk full" }));
  await expect(console.getByRole("alert")).toContainText("Disk full");
  await expect(record).toBeEnabled();
  await record.click();
  await expect(stop).toBeEnabled();
  await page.evaluate(() => fixture.emit("serial-closed", {id:fixture.serialPort,error:"Unplugged"}));
  await expect(button("Reconnect",console)).toBeVisible();
  await button("Reconnect",console).click();
  await expect(record).toBeEnabled();
  await expect(stop).toHaveCount(0);
  assert.equal(await page.evaluate(() => fixture.serialOpens),2);
  return { settings: "independent limits, validation, unlimited and reload", serial: "cancel, save, stop, unfocused session, disk error, disconnect and reconnect" };
}
