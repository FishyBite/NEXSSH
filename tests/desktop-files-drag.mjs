import assert from "node:assert/strict";

export async function exerciseFilesDrag({ page, expect }) {
  const pane = side => page.locator(`[data-file-side="${side}"]`);
  const transfers = () => page.evaluate(() => fixture.calls.filter(call => call.args?.action === "transfer_start").map(call => call.args.payload));
  const sessionId = await page.evaluate(() => [...fixture.sessions.keys()][0]);
  const drag = async (side, target, folder = false) => {
    const source = pane(side).getByRole("button", { name: ".profile", exact: true });
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    assert(sourceBox && targetBox);
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, folder ? targetBox.y + targetBox.height / 2 : targetBox.y + targetBox.height - 18, { steps: 16 });
    await expect(page.locator(".file-drag-ghost")).toBeVisible();
    await page.mouse.up();
    await expect(page.locator(".file-drag-ghost")).toHaveCount(0);
  };
  await drag("local", pane("remote").locator(".file-list"));
  await expect.poll(async () => (await transfers()).length).toBe(1);
  const {batchId:firstBatch,...first} = (await transfers())[0];
  assert.match(firstBatch,/^[\da-f-]{36}$/i);
  assert.deepEqual(first, {
    sessionId, source: "C:\\Users\\Test User/.profile", destination: "/var/home/test-user/.profile", direction: "upload", protocol: "sftp",
  });
  await expect(page.getByRole("heading", { name: "File manager", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: /^Transfer with/ }).selectOption("scp");
  await drag("remote", pane("local").getByRole("button", { name: "Documents", exact: true }), true);
  await expect.poll(async () => (await transfers()).length).toBe(2);
  const {batchId:secondBatch,...second} = (await transfers())[1];
  assert.notEqual(firstBatch,secondBatch);
  assert.deepEqual(second, {
    sessionId, source: "/var/home/test-user/.profile", destination: "C:\\Users\\Test User/Documents\\.profile", direction: "download", protocol: "scp",
  });
  await expect(page.getByRole("heading", { name: "File manager", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => fixture.calls.filter(call => call.args?.action === "transfer_list").length)).toBeGreaterThan(1);
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.args?.action === "ssh_write").length), 0);
  return { uploadUsesSelectedServer: true, downloadToDirectoryUsesSelectedProtocol: true, filesStaysOpenAfterDrop: true, queueRefreshed: true };
}
