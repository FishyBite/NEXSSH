import assert from "node:assert/strict";

export async function exerciseTerminalRetry({
  page,
  expect,
  fixture,
  paletteAction,
}) {
  const nav = (name) =>
    page.locator(".sidebar").getByRole("button", { name, exact: true });
  const writes = () =>
    page.evaluate(() =>
      window.fixture.calls.filter((call) => call.args?.action === "ssh_write"),
    );
  await nav("Snippets").click();
  await page.getByRole("button", { name: "Review & run", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Review command", exact: true })
    .getByRole("button", { name: /^Execute on / })
    .click();
  await expect.poll(async () => (await writes()).length).toBe(1);
  const originalWrite = (await writes())[0].args.payload;
  assert.equal(originalWrite.data, "fixture_no_execute\r");

  await paletteAction(fixture.state_load.hosts[1].name);
  await expect(page.getByRole("tab")).toHaveCount(2);
  const activeId = await page
    .getByRole("tab", { selected: true })
    .evaluate((button) => button.closest(".session-tab").dataset.sessionId);
  assert.notEqual(
    activeId,
    originalWrite.sessionId,
    "The active target must differ from the snippet target",
  );
  const before = await page.evaluate(() => ({
    ids: [...window.fixture.sessions.keys()],
    calls: window.fixture.calls.length,
  }));

  await page.evaluate((sessionId) => {
    window.fixture.injectTerminalRenderError = true;
    window.fixture.emit("terminal-status", {sessionId, status: "connected"});
  }, activeId);
  await expect(
    page.getByRole("heading", {
      name: "Terminal display interrupted",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore workspace", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.evaluate(() => {
    window.fixture.injectTerminalRenderError = false;
  });
  await page
    .getByRole("button", { name: "Retry terminal view", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".xterm")).toHaveCount(2);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const after = await page.evaluate(
    (start) => ({
      ids: [...window.fixture.sessions.keys()],
      calls: window.fixture.calls
        .slice(start)
        .filter((call) =>
          ["ssh_connect", "ssh_disconnect", "ssh_write"].includes(
            call.args?.action,
          ),
        ),
    }),
    before.calls,
  );
  assert.deepEqual(
    after.ids,
    before.ids,
    "Retry must preserve native SSH sessions",
  );
  assert.deepEqual(
    after.calls,
    [],
    "Retry must not reconnect, disconnect or replay the previous snippet",
  );
  assert.equal(
    (await writes()).length,
    1,
    "Only the user's original snippet submission may be written",
  );
  assert.equal(
    await page
      .getByRole("tab", { selected: true })
      .evaluate((button) => button.closest(".session-tab").dataset.sessionId),
    activeId,
  );
  return {
    preservedSessionIds: true,
    activeTargetChangedBeforeFailure: true,
    noCommandReplay: true,
    originalWriteCount: 1,
  };
}
