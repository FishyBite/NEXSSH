import assert from "node:assert/strict";

export async function exerciseShellFiles({ page, expect, fixture }) {
  const root = "/srv/Team's files";
  const button = (name) => page.getByRole("button", {name, exact:true});
  const mode = (name) => page.getByRole("group", {name:"Session view"}).getByRole("button", {name, exact:true});
  const drawer = page.getByRole("complementary", {name:/^Remote files for /});
  const entries = drawer.locator(".drawer-entries");
  const subfolder = drawer.getByRole("button", {name:"Open folder builds",exact:true});
  const file = drawer.getByRole("button", {name:"Select owner's notes.txt",exact:true});
  const useFolder = drawer.getByRole("button",{name:"Use folder in terminal",exact:true});
  const address = drawer.getByRole("textbox",{name:"Remote folder path"});
  const fullAddress = page.getByRole("textbox",{name:"remote directory path",exact:true});
  const ids = () => page.evaluate(() => [...window.fixture.sessions.keys()]);
  const surface = (id) => page.locator('.terminal-pane[data-session-id="'+id+'"] .xterm-container');
  const shell = (id) => surface(id).locator(".xterm-helper-textarea");
  const calls = (action) => page.evaluate((action) => window.fixture.calls.filter(c => c.args?.action===action).map(c=>c.args.payload),action);
  const [a] = await ids();
  const tab = n => page.getByRole("tab",{name:fixture.state_load.hosts[0].name+" · "+n,exact:true});

  await page.evaluate(() => {
    const state = window.fixture;
    const ipc = window.__TAURI_INTERNALS__;
    const invoke = ipc.invoke.bind(ipc);
    state.received = [];
    state.newFiles = new Map();
    state.dropScale = 1.5;
    ipc.invoke = async (command,args={}) => {
      if (command === "plugin:window|scale_factor") return state.dropScale;
      if (command !== "request") return invoke(command,args);
      const {action,payload} = args;
      if (action === "file_list" && payload.side === "remote") {
        if (!state.sessions.has(payload.sessionId)) throw new Error("Invalid file session");
        const dir = payload.path==="." ? "/home/fixture" : payload.path;
        const files = state.newFiles.get(payload.sessionId+":"+dir) || [];
        return {path:dir,entries:["builds","owner's notes.txt",...files].map((name,i) => ({
          path:dir+"/"+name,name,isDir:i===0,isSymlink:false,size:23,modified:1794400000,permissions:"644",
        }))};
      }
      if (action === "transfer_start") state.received.push({...payload});
      return invoke(command,args);
    };
  });

  await fullAddress.fill(root);
  await fullAddress.press("Enter");
  await expect(page.locator('[data-file-side="remote"]').getByRole("button",{name:"builds",exact:true})).toBeVisible();
  await button("Remote folder actions").click();
  await page.getByRole("menuitem",{name:"Open terminal here"}).click();
  await expect(tab(2)).toHaveAttribute("aria-selected","true");
  const [,b] = await ids();
  assert.ok(a && b && a!==b);
  await tab(1).click();
  await expect(shell(a)).toBeFocused();
  const before = await calls("ssh_connect");
  await page.keyboard.press("F6");
  await expect(file).toBeVisible();
  await expect.poll(() => entries.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(file).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(subfolder).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(address).toHaveValue(root+"/builds");
  await expect(file).toBeVisible();
  await page.keyboard.press("F6");
  await expect(shell(a)).toBeFocused();
  await page.keyboard.type("tail -f ");
  const dragBegin = (await calls("ssh_write")).length;
  const start = await file.boundingBox();
  const end = await surface(a).boundingBox();
  assert.ok(start && end);
  await page.mouse.move(start.x+start.width/2,start.y+start.height/2);
  await page.mouse.down();
  await page.mouse.move(end.x+end.width/2,end.y+end.height/2,{steps:18});
  await page.mouse.up();
  await expect(shell(a)).toBeFocused();
  await page.keyboard.type("z");
  const quoted = p => "'"+p.replaceAll("'","'\\''")+"'";
  await expect.poll(async () => (await calls("ssh_write")).slice(dragBegin)).toEqual([
    {sessionId:a,data:quoted(root+"/builds/owner's notes.txt")},{sessionId:a,data:"z"},
  ]);

  // The editable PTY line survives cancel, and insertion always requires a user gesture.
  const beforeCancel = await calls("ssh_write");
  await useFolder.click();
  const review = page.getByRole("dialog",{name:"Use folder in terminal"});
  await expect(review).toBeVisible();
  await page.keyboard.press("F6");
  await expect(review).toBeVisible();
  await review.getByRole("button",{name:"Keep current input",exact:true}).click();
  await expect(shell(a)).toBeFocused();
  assert.deepEqual(await calls("ssh_write"),beforeCancel);
  await useFolder.click();
  await review.getByRole("button",{name:"Insert at cursor",exact:true}).click();
  await expect(shell(a)).toBeFocused();
  await expect.poll(async () => (await calls("ssh_write")).at(-1)).toEqual({sessionId:a,data:"cd -- "+quoted(root+"/builds")});

  // The full file manager stays in A even though B has the same host and username.
  await mode("SFTP").click();
  await expect(fullAddress).toHaveValue(root+"/builds");
  const remoteList = page.locator('[data-file-side="remote"] .file-list');
  await remoteList.focus();
  await page.keyboard.press("F6");
  await expect(shell(a)).toBeFocused();
  await page.evaluate((id) => {
    window.fixture.emit("terminal-data",{sessionId:id,data:btoa("\r\nfresh$ \x1b]133;A\x07\x1b]133;B\x07")});
  },a);
  await mode("SFTP").click();
  await page.locator('[data-file-side="remote"]').getByRole("button",{name:"builds",exact:true}).click({button:"right"});
  const cleanWrites = (await calls("ssh_write")).length;
  await page.getByRole("menuitem",{name:"Use folder in terminal",exact:true}).click();
  await expect(shell(a)).toBeFocused();
  await expect(review).toHaveCount(0);
  await page.keyboard.type("x");
  await expect.poll(async () => (await calls("ssh_write")).slice(cleanWrites)).toEqual([
    {sessionId:a,data:"cd -- "+quoted(root+"/builds/builds")},{sessionId:a,data:"x"},
  ]);

  // Real Tauri event shape and physical coordinates (150% scale).
  const queued = () => page.evaluate(() => window.fixture.received);
  const osPaths = ["C:\\Fixture\\notes one.txt","C:\\Fixture\\second.txt"];
  const emitDrag = async (type,target,paths=osPaths) => {
    const box = await target.boundingBox();
    assert.ok(box);
    const x=box.x+box.width/2, y=target===entries ? box.y+box.height-8 : box.y+box.height/2;
    await page.evaluate(({type,x,y,paths})=>{
      const state=window.fixture;
      const position={x:Math.round(x*state.dropScale),y:Math.round(y*state.dropScale)};
      state.emit("tauri://drag-"+type,{position,paths});
    },{type,x,y,paths});
  };
  await expect(file).toBeVisible();
  await emitDrag("enter",entries);
  const hint=drawer.locator(".drawer-drop-hint");
  await expect(hint).toContainText(root+"/builds");
  await expect(hint).toContainText(fixture.state_load.hosts[0].name);
  if (process.env.VEXSSH_SHELL_FILES_CAPTURE) await page.screenshot({path:process.env.VEXSSH_SHELL_FILES_CAPTURE});
  await emitDrag("drop",entries);
  await expect.poll(async()=> (await queued()).length).toBe(2);
  const [first,second]=await queued();
  assert.ok(first.batchId && second.batchId===first.batchId);
  assert.deepEqual([first,second].map(({batchId,...other})=>other),osPaths.map(path=>({
    sessionId:a,direction:"upload",protocol:"sftp",source:path,destination:root+"/builds/"+path.split("\\").at(-1),
  })));
  await expect(shell(a)).toBeFocused();
  await page.evaluate(({sessionId,dir,destination})=>{
    const state=window.fixture;
    state.newFiles.set(sessionId+":"+dir,["notes one.txt"]);
    state.emit("transfer-progress",{id:"t1",sessionId,source:"C:\\Fixture\\notes one.txt",destination,direction:"upload",protocol:"sftp",
      status:"completed",totalBytes:17,transferredBytes:17,speedBytesPerSecond:0,etaSeconds:null,startedAt:10,finishedAt:11});
  },{sessionId:a,dir:root+"/builds",destination:first.destination});
  await expect(drawer.getByRole("button",{name:"Select notes one.txt",exact:true})).toBeVisible();
  await expect(shell(a)).toBeFocused();
  await emitDrag("enter",subfolder);
  await expect(hint).toContainText(root+"/builds/builds");
  await tab(2).click();
  await expect(shell(b)).toBeFocused();
  await expect(file).toBeVisible();
  await emitDrag("drop",entries);
  await page.keyboard.type("b");
  await expect.poll(async()=> (await calls("ssh_write")).at(-1)).toEqual({sessionId:b,data:"b"});
  assert.equal((await queued()).length,2,"Drop redirected to another same-host tab");
  await button("Split terminal").click();
  await page.getByRole("menuitemradio",{name:"Split side by side"}).click();
  await expect(surface(a)).toBeVisible();
  const priorWrites=await calls("ssh_write");
  const source=await file.boundingBox(), otherPane=await surface(a).boundingBox();
  assert.ok(source && otherPane);
  await page.mouse.move(source.x+source.width/2,source.y+source.height/2);
  await page.mouse.down();
  await page.mouse.move(otherPane.x+otherPane.width/2,otherPane.y+otherPane.height/2,{steps:15});
  await page.mouse.up();
  await expect(tab(2)).toHaveAttribute("aria-selected","true");
  await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.deepEqual(await calls("ssh_write"),priorWrites,"Drop inserted into an inactive split terminal");
  await button("Split terminal").click();
  await page.getByRole("menuitemradio",{name:"Single pane"}).click();
  await page.setViewportSize({width:760,height:560});
  await expect(useFolder).toBeInViewport();
  await expect(file).toBeInViewport();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  await file.focus();
  await page.keyboard.press("F6");
  await page.keyboard.type("n");
  await expect.poll(async()=> (await calls("ssh_write")).at(-1)).toEqual({sessionId:b,data:"n"});
  assert.deepEqual(await calls("ssh_connect"),before);
  assert.deepEqual(await ids(),[a,b]);
  return {sessionBoundDragAndUpload:true,firstKeystroke:true,folderDraftPreserved:true,
    verifiedCleanPrompt:true,keyboardRoundTrip:true,physicalDropCoordinates:true,completionRefresh:true,otherSplitIgnored:true};
}
