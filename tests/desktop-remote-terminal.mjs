import assert from "node:assert/strict";

export async function exerciseRemoteTerminalActions({ page, expect, fixture, nav }) {
  const host = fixture.state_load.hosts[0];
  const sourceId = await page.evaluate(() => [...window.fixture.sessions.keys()][0]);
  const remote = page.locator('[data-file-side="remote"]');
  const sftp = page.getByRole("group",{name:"Session view"}).getByRole("button",{name:"SFTP",exact:true});
  const menu = async (entry, action) => {
    await remote.getByRole("button", {name:entry,exact:true}).click({button:"right"});
    await page.getByRole("menuitem", {name:action,exact:true}).click();
  };
  const requests = action => page.evaluate(name => window.fixture.calls.filter(call => call.args?.action === name).map(call => call.args.payload),action);
  await menu("Documents","Open terminal here");
  const tab = page.getByRole("tab",{name:host.name+" · 2",exact:true});
  await expect(tab).toHaveAttribute("aria-selected","true");
  await expect(tab).toHaveAttribute("title",new RegExp(host.username+"@"+host.hostname));
  await expect(page.getByRole("tab",{name:host.name+" · 1",exact:true})).toBeVisible();
  const openedId = await page.evaluate(() => [...window.fixture.sessions.keys()][1]);
  assert.ok(openedId && openedId !== sourceId);
  assert.deepEqual(await requests("ssh_open_here"),[{sessionId:sourceId,path:"/var/home/test-user/Documents"}]);
  assert.deepEqual(await requests("ssh_write"),[]);

  await tab.dblclick();
  await page.getByRole("textbox",{name:"Terminal name",exact:true}).fill("Deploy");
  await page.getByRole("button",{name:"Rename",exact:true}).click();
  await sftp.click();
  async function chooseTarget() {
    await page.getByRole("tab",{name:host.name+" · 1",exact:true}).click();
    await menu("owner's report.log","Insert path into terminal");
    await page.getByRole("dialog",{name:"Insert path into terminal",exact:true})
      .getByRole("button",{name:"Deploy",exact:true}).click();
  }
  await chooseTarget();
  const targetInput = page.locator('.terminal-pane[data-session-id="'+openedId+'"] .xterm-helper-textarea');
  await expect(targetInput).toBeFocused();
  await page.keyboard.type("x");
  const inserted={sessionId:openedId,data:"'/var/home/test-user/owner'\\''s report.log'"};
  const typed={sessionId:openedId,data:"x"};
  await expect.poll(()=>requests("ssh_write")).toEqual([inserted,typed]);
  assert.deepEqual(await requests("ssh_check_path_target"),[{sourceId,targetId:openedId}]);

  await page.getByRole("button",{name:"Command",exact:true}).click();
  const composer=page.getByRole("combobox",{name:"Command",exact:true});
  await composer.fill("oc get");
  await expect(page.getByRole("option")).toHaveCount(1);
  await composer.press("Tab");
  await expect(composer).toHaveValue("oc get pods");
  assert.deepEqual(await requests("ssh_write"),[inserted,typed]);
  await composer.press("Enter");
  const submitted={sessionId:openedId,data:"oc get pods\r"};
  await expect.poll(()=>requests("ssh_write")).toEqual([inserted,typed,submitted]);

  await sftp.click();
  await page.evaluate(()=>{window.fixture.holdTargetCheck=true;});
  await chooseTarget();
  await expect.poll(()=>page.evaluate(()=>typeof window.fixture.finishTargetCheck)).toBe("function");
  await nav("Hosts").click();
  await expect(page.getByRole("heading",{name:"Your hosts",exact:true})).toBeVisible();
  await page.evaluate(async()=>{window.fixture.finishTargetCheck();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  await expect(page.getByRole("heading",{name:"Your hosts",exact:true})).toBeVisible();
  assert.deepEqual(await requests("ssh_write"),[inserted,typed,submitted]);
  return {bundle:await page.locator('script[src*="/assets/index-"]').getAttribute("src"),
    openedDirectoryOnCorrectConnection:true, numberedTabsAndRenaming:true,
    targetSelectedAndQuotedOnce:true, immediateTyping:true, scopedEditableSuggestions:true,
    abandonedActionCancelled:true};
}
