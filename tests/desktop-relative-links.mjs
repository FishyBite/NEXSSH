import assert from "node:assert/strict";
import { clickOutputPath } from "./click-output-path.mjs";

export async function exerciseRelativeLinks({page, expect, fixture}) {
  await page.getByRole("button", {name:"Remote folder actions",exact:true}).click();
  await page.getByRole("menuitem", {name:"Open terminal here",exact:true}).click();
  const ids = await page.evaluate(() => [...window.fixture.sessions.keys()]);
  const sessionId = ids[1];
  assert.ok(sessionId);
  await page.evaluate(({sessionId,hostname}) => {
    const state = window.fixture;
    const transport = window.__TAURI_INTERNALS__;
    const invoke = transport.invoke.bind(transport);
    state.relativePreviews = [];
    transport.invoke = async (cmd,args={}) => {
      const p = args.payload;
      if (cmd === "request" && args.action === "file_preview_path") {
        state.relativePreviews.push(p);
        return {kind:"file",path:p.path,content:"first\nsecond",revision:"fixture-rev"};
      }
      if (cmd === "request" && args.action === "file_list" && p.path === "/var/home/test-user/Documents")
        return {path:p.path,entries:[]};
      return invoke(cmd,args);
    };
    const osc = dir => "\x1b]7;file://" + hostname + dir + "\x07";
    const text = "\r\n./ask.txt\r\n" + osc("/srv/first") + "./logs/old.log:2\r\n" +
      osc("/srv/later") + "src/recent.ts\r\n";
    state.emit("terminal-data",{sessionId,data:btoa(text)});
  },{sessionId,hostname:fixture.state_load.hosts[0].hostname});
  const preview = page.getByRole("dialog",{name:"File preview",exact:true});
  const picker = page.getByRole("dialog",{name:"Choose remote folder",exact:true});
  const requests = () => page.evaluate(() => window.fixture.relativePreviews);
  const click = fragment => clickOutputPath(page,sessionId,fragment,true);
  await click("old.log");
  await expect(preview.locator(".preview-target-line")).toHaveText("second");
  assert.equal((await requests()).at(-1).path,"/srv/first/logs/old.log");
  await page.keyboard.press("Escape");
  await click("recent.ts");
  await expect(preview).toBeVisible();
  assert.equal((await requests()).at(-1).path,"/srv/later/src/recent.ts");
  await page.keyboard.press("Escape");
  await click("ask.txt");
  await expect(picker).toBeVisible();
  assert.equal((await requests()).length,2);
  await picker.getByRole("button",{name:"Documents",exact:true}).click();
  await expect(picker.getByRole("textbox",{name:"Remote folder"})).toHaveValue("/var/home/test-user/Documents");
  await picker.getByRole("button",{name:"Use this folder",exact:true}).click();
  await expect(preview).toBeVisible();
  assert.equal((await requests()).at(-1).path,"/var/home/test-user/Documents/ask.txt");
  assert.ok((await requests()).every(p => p.sessionId === sessionId && p.side === "remote"));
  await page.keyboard.press("Escape");
  await page.keyboard.type("z");
  await expect.poll(() => page.evaluate(() => window.fixture.calls.filter(c=>c.args?.action === "ssh_write").map(c=>c.args.payload))).toEqual([{sessionId,data:"z"}]);
  assert.deepEqual(await page.evaluate(() => [...window.fixture.sessions.keys()]),ids);
  return {cwdAtOutputTime:true,confirmedRemoteFolder:true,sameSessionAndTyping:true};
}
