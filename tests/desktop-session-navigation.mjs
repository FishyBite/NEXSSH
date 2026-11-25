import assert from "node:assert/strict";

export async function exerciseSessionNavigation({ page, expect, fixture, nav }) {
  await page.evaluate(() => {
    const transport = window.__TAURI_INTERNALS__;
    const invoke = transport.invoke.bind(transport);
    const state = window.fixture;
    const transfers = new Map();
    state.progress = (detail) => {
      transfers.set(detail.id, detail);
      state.emit("transfer-progress", detail);
    };
    transport.invoke = async (cmd, args = {}) => {
      if (cmd !== "request") return invoke(cmd, args);
      const {action, payload} = args;
      if (action === "transfer_list") return [...transfers.values()];
      if (action === "file_tail_close") return null;
      if (action === "file_tail") return {text:payload.cursor ? "" : "fixture\n",cursor:{offset:8,anchor:"fixture"},more:false,reset:false};
      if (action !== "file_list") return invoke(cmd,args);
      const remote = payload.side === "remote";
      const path = !payload.path || payload.path === "." ? (remote ? "/home/fixture" : "C:\\Fixture") : payload.path;
      if (path === state.heldPath) {
        state.heldPath = undefined;
        await new Promise(resolve => { state.releaseList = resolve; });
        delete state.releaseList;
      }
      const sep = remote ? "/" : "\\";
      return {path, entries:Array.from({length:90}, (_,n) => {
        const name = "entry-" + String(n).padStart(2,"0") + ".log";
        return {name,path:path+sep+name,isDir:false,isSymlink:false,size:18,modified:1794450000,permissions:"644"};
      })};
    };
  });
  const sessionIds = () => page.evaluate(() => [...window.fixture.sessions.keys()]);
  const writes = () => page.evaluate(() => window.fixture.calls.filter(c => c.args?.action === "ssh_write").map(c => c.args.payload));
  const disconnects = () => page.evaluate(() => window.fixture.calls.filter(c => c.args?.action === "ssh_disconnect").map(c => c.args.payload.sessionId));
  const roles = (name) => page.getByRole("button", {name,exact:true});
  const mode = (name) => page.getByRole("group", {name:"Session view"}).getByRole("button",{name,exact:true});
  const pathField = (side) => page.getByRole("textbox",{name:side+" directory path",exact:true});
  const pane = (side) => page.locator('[data-file-side="'+side+'"]');
  const list = (side) => pane(side).locator(".file-list");
  const check = (side,n) => pane(side).getByRole("checkbox",{name:"Select entry-"+n+".log",exact:true});
  const input = (id) => page.locator('.terminal-pane[data-session-id="'+id+'"] .xterm-helper-textarea');
  const selectedTab = (name) => page.getByRole("tab",{name,exact:true});
  const hostName = fixture.state_load.hosts[0].name;
  const nameA = hostName+" · 1";
  const nameB = hostName+" · 2";
  const [idA] = await sessionIds();

  // Open an independent shell on the same saved host from the regular UI.
  await pane("remote").getByRole("button",{name:"Remote folder actions"}).click();
  await page.getByRole("menuitem",{name:"Open terminal here"}).click();
  await expect(selectedTab(nameB)).toHaveAttribute("aria-selected","true");
  const [,idB] = await sessionIds();
  assert.ok(idB && idB !== idA);
  const initialConnections = await page.evaluate(() => window.fixture.calls.filter(c =>
    ["ssh_connect","ssh_open_here"].includes(c.args?.action)).length);
  const record = [];
  await expect(input(idB)).toBeFocused();
  await page.keyboard.type("b");
  record.push({sessionId:idB,data:"b"});
  await expect.poll(writes).toEqual(record);
  await selectedTab(nameA).click();
  await expect(input(idA)).toBeFocused();
  await page.keyboard.press("Control+Shift+e");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  await expect(selectedTab(nameA)).toHaveAttribute("aria-selected","true");
  await expect(page.getByRole("tablist")).toHaveCount(1);

  async function setFolder(side,path,number,offset) {
    await pathField(side).fill(path);
    await pathField(side).press("Enter");
    const row = check(side,number);
    const full = path+(side==="local" ? "\\" : "/")+"entry-"+number+".log";
    await expect(row.locator("..")).toHaveAttribute("data-file-path",full);
    await row.check();
    await list(side).evaluate((el,top) => {el.scrollTop = top;},offset);
    await expect.poll(() => list(side).evaluate(el=>el.scrollTop)).toBe(offset);
  }
  async function expectFolder(side,path,number,offset) {
    await expect(pathField(side)).toHaveValue(path);
    const row = check(side,number);
    await expect(row.locator("..")).toHaveAttribute("data-file-path",path+(side==="local" ? "\\" : "/")+"entry-"+number+".log");
    await expect(row).toBeChecked();
    await expect.poll(() => list(side).evaluate(el=>el.scrollTop)).toBe(offset);
  }
  await setFolder("local","C:\\deploy","04",135);
  await setFolder("remote","/deploy","09",245);
  await selectedTab(nameB).click();
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  await setFolder("local","C:\\logs","12",370);
  await setFolder("remote","/logs","18",470);
  // File-selection checkboxes are a normal keyboard landing point in SFTP.
  await check("remote","18").evaluate(el=>el.focus({preventScroll:true}));
  await page.keyboard.press("Control+Shift+Tab");
  await expect(selectedTab(nameA)).toHaveAttribute("aria-selected","true");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  await expectFolder("local","C:\\deploy","04",135);
  await expectFolder("remote","/deploy","09",245);
  await mode("Terminal").click();
  await page.keyboard.type("a");
  record.push({sessionId:idA,data:"a"});
  await expect.poll(writes).toEqual(record);
  await expect(input(idA)).toBeFocused();
  await page.keyboard.press("Control+Shift+e");
  await expectFolder("remote","/deploy","09",245);
  await mode("SFTP").focus();
  await page.keyboard.press("Control+Tab");
  await expect(selectedTab(nameB)).toHaveAttribute("aria-selected","true");
  await expectFolder("local","C:\\logs","12",370);
  await expectFolder("remote","/logs","18",470);

  // A protected text control and a modal must neither switch nor close a session.
  await pathField("remote").focus();
  await page.keyboard.press("Control+Shift+w");
  await expect(selectedTab(nameB)).toHaveAttribute("aria-selected","true");
  await selectedTab(nameB).dblclick();
  const rename = page.getByRole("textbox",{name:"Terminal name",exact:true});
  await rename.focus();
  await page.keyboard.press("Control+Tab");
  await page.keyboard.press("Control+Shift+e");
  await page.keyboard.press("Control+Shift+w");
  await expect(rename).toBeVisible();
  assert.deepEqual(await disconnects(),[]);
  await page.keyboard.press("Escape");
  await expect(rename).toBeHidden();
  await expect(selectedTab(nameB)).toHaveAttribute("aria-selected","true");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  await pane("remote").getByRole("button",{name:"entry-18.log",exact:true}).click({button:"right"});
  await page.keyboard.press("Control+Shift+w");
  await expect(page.getByRole("menuitem",{name:"Watch log",exact:true})).toBeVisible();
  await page.getByRole("menuitem",{name:"Watch log",exact:true}).click();
  const log = page.getByRole("complementary",{name:"Live log viewer"});
  await log.getByRole("button",{name:"Pause",exact:true}).focus();
  await page.keyboard.press("Control+Tab");
  await page.keyboard.press("Control+Shift+e");
  await page.keyboard.press("Control+Shift+w");
  await expect(selectedTab(nameB)).toHaveAttribute("aria-selected","true");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  assert.deepEqual(await disconnects(),[]);
  await log.getByRole("button",{name:"Close log viewer"}).click();
  await list("remote").evaluate(el=>{el.scrollTop=470;});

  const setProgress = (id,sessionId,file,percent,status) => page.evaluate(
    ({id, sessionId,file,percent,status}) => window.fixture.progress({
      id,sessionId,direction:"upload",source:"C:\\"+file,destination:"/fixture/"+file,
      protocol:"sftp",status,totalBytes:1000,transferredBytes:10*percent,speedBytesPerSecond:25,
      etaSeconds:10,startedAt:1794450000,finishedAt:status==="completed" ? 1794450022 : null,
    }),{id,sessionId,file,percent,status});
  const badge = name => page.getByRole("button",{name:new RegExp("^Transfers for "+name+":")});
  await mode("Terminal").click();
  await expect(input(idB)).toBeFocused();
  await setProgress("upA",idA,"archive-A.zip",62,"running");
  await expect(badge(nameA)).toContainText("62%");
  await expect(badge(nameB)).toHaveCount(0);
  await expect(input(idB)).toBeFocused();
  await setProgress("upB",idB,"archive-B.zip",21,"running");
  await expect(badge(nameB)).toContainText("21%");
  await page.setViewportSize({width:760,height:560});
  await expect(mode("SFTP")).toBeInViewport();
  await expect(selectedTab(nameB)).toBeInViewport();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"Narrow workspace overflows horizontally");
  if (process.env.NEXSSH_SESSION_NAV_CAPTURE) {
    await page.screenshot({path:process.env.NEXSSH_SESSION_NAV_CAPTURE});
  }
  await page.setViewportSize({width:1380,height:900});
  await setProgress("upA",idA,"archive-A.zip",100,"completed");
  await expect(badge(nameA)).toHaveCount(0);
  await expect(input(idB)).toBeFocused();
  await page.keyboard.type("c");
  record.push({sessionId:idB,data:"c"});
  await expect.poll(writes).toEqual(record);
  await setProgress("upA2",idA,"active-A.zip",38,"running");
  await badge(nameA).click();
  await expect(page.getByRole("heading",{name:"Transfers",exact:true})).toBeVisible();
  await expect(page.getByText("active-A.zip",{exact:true})).toBeVisible();
  await expect(page.getByText("archive-B.zip",{exact:true})).toHaveCount(0);
  await roles("Back to terminal").click();
  await expect(input(idB)).toBeFocused();
  await mode("Database").click();
  await badge(nameA).click();
  await expect(page.getByText("active-A.zip",{exact:true})).toBeVisible();
  await expect(page.getByText("archive-B.zip",{exact:true})).toHaveCount(0);
  await roles("Back to database").click();
  await expect(mode("Database")).toHaveAttribute("aria-pressed","true");
  await expect(selectedTab(nameB)).toHaveAttribute("aria-selected","true");
  await mode("Terminal").click();
  await expect(input(idB)).toBeFocused();
  await badge(nameA).click();
  await roles("Show all transfers").click();
  await expect(page.getByText("archive-B.zip",{exact:true})).toBeVisible();

  async function configureShortcut(label) {
    await nav("Settings").click();
    await page.getByRole("navigation",{name:"Settings categories"}).getByRole("button",{name:"General",exact:true}).click();
    await page.getByRole("combobox",{name:"Switch Terminal / SFTP",exact:true}).selectOption({label});
    await roles("Save changes").click();
    await expect.poll(()=>page.evaluate(()=>window.fixture.config.settings.sessionViewShortcut)).toBe(label);
  }
  await configureShortcut("Off");
  await nav("Files").click();
  await mode("SFTP").focus();
  await page.keyboard.press("Control+Shift+e");
  await page.keyboard.press("Control+Shift+y");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  await configureShortcut("Ctrl+Shift+Y");
  await nav("Files").click();
  await selectedTab(nameB).click();
  await mode("SFTP").focus();
  await page.keyboard.press("Control+Shift+e");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  await page.keyboard.press("Control+Shift+y");
  await page.keyboard.type("d");
  record.push({sessionId:idB,data:"d"});
  await expect.poll(writes).toEqual(record);
  await expect(input(idB)).toBeFocused();

  // Select A in Files while B was the last shell to receive keyboard input.
  await page.keyboard.press("Control+Shift+y");
  await selectedTab(nameA).click();
  await page.evaluate(()=>{window.fixture.heldPath="/late-directory";});
  await pathField("remote").fill("/late-directory");
  await pathField("remote").press("Enter");
  await expect.poll(()=>page.evaluate(()=>typeof window.fixture.releaseList)).toBe("function");
  await selectedTab(nameB).click();
  await expectFolder("remote","/logs","18",470);
  await page.evaluate(async()=>{
    window.fixture.releaseList();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
  await expectFolder("remote","/logs","18",470);
  await selectedTab(nameA).click();
  await mode("SFTP").focus();
  await page.keyboard.press("Control+Shift+w");
  await expect.poll(disconnects).toEqual([idA]);
  await expect(selectedTab(nameB)).toHaveAttribute("aria-selected","true");
  await expect(mode("SFTP")).toHaveAttribute("aria-pressed","true");
  await expectFolder("remote","/logs","18",470);
  await mode("Terminal").click();
  await expect(input(idB)).toBeFocused();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c =>
    ["ssh_connect","ssh_open_here"].includes(c.args?.action)).length),initialConnections);
  return {
    bundle:await page.locator('script[src*="/assets/index-"]').getAttribute("src"),
    sharedSessionStrip:true, sameSessionImmediateTyping:true, restoredDirectoriesSelectionsScroll:true,
    keyboardPreservesMode:true, configurableModeShortcut:true, closeTargetsVisibleSession:true, staleFileListingIgnored:true,
    protectedInputModalMenuAndLog:true, transferIndicatorsScoped:true, backgroundCompletionPreservedFocus:true
  };
}
