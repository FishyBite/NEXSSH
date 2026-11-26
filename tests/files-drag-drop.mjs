import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const project = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const { build } = require("esbuild");
const { chromium, expect } = require("@playwright/test");
const compiled = await build({
  stdin: {
    contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {FilesView} from './src/Files';
      import {Transfers} from './src/Files';
      const initialHosts=['alpha','beta'].map(id=>({id,name:id==='alpha'?'Alpha':'Beta',hostname:id+'.example.invalid',username:'core',port:22,workspaceId:'test',authMethod:'key',keySource:'file',identityFile:'fixture-key',tags:[],color:'#6C8CFF',notes:'',favorite:false}));
      const initialSessions=initialHosts.map(host=>({id:host.id+'-1',hostId:host.id,name:host.name,status:'connected',latencyMs:1}));
      const state=window.fixture={calls:[],notifications:[],transferCallbacks:[],nativeListeners:new Set(),scale:1,holdScale:false,holdTransfer:false,pendingTransfers:[],pendingScales:[],failPath:null,deferPath:null};
      const item=(base,name,isDir=false)=>({name,path:base+'/'+name,size:isDir?4096:4,isDir,isSymlink:false,modified:1,permissions:'644'});
      state.emitNative=(type,position,paths=[])=>{for(const listener of state.nativeListeners)listener({payload:{type,position,paths}});};
      state.scaleFactor=()=>state.holdScale?new Promise(resolve=>state.pendingScales.push(()=>resolve(state.scale))):Promise.resolve(state.scale);
      state.request=async(action,payload)=>{
        state.calls.push({action,payload});
        if(action==='file_list'){
          const base=payload.side==='local'?'C:/local':'/srv/shared';
          const path=!payload.path||payload.path==='.'?base:payload.path;
          const entries=state.overflowSide===payload.side?Array.from({length:40},(_,index)=>({...item(path,'folder-'+String(index+1).padStart(2,'0'),true),size:index+1})):[item(path,'docs',true),item(path,'one.txt'),item(path,'two.txt')];
          const result={path,entries:[...(path.endsWith('/empty')?[]:entries),...(state.finished&&payload.side==='remote'?[item(path,'done.zip')]:[])]};
          if(path===state.failPath)throw new Error('Fixture listing unavailable');
          if(path===state.deferPath){state.deferPath=null;return new Promise(resolve=>state.releaseList=()=>resolve(result));}
          return result;
        }
        if(action==='transfer_start'){
          if(state.failTransferAt===state.calls.filter(call=>call.action==='transfer_start').length)throw new Error('Fixture queue unavailable');
          if(state.holdTransfer)return new Promise(resolve=>state.pendingTransfers.push(()=>resolve({id:'queued'})));
          return {id:'queued'};
        }
        if(action==='file_read')return {content:'fixture content',revision:'fixture-revision'};
        if(action==='file_tail'){
          const chunks=state.logChunks||[]; const i=payload.cursor?.offset||0;
          return {text:chunks.slice(i).join(''),cursor:{offset:chunks.length,anchor:'test'},more:false,reset:false};
        }
        if(action==='clipboard_write_text')state.clip=payload.text;
        return {ok:true};
      };
      addEventListener('pointerdown',event=>{state.pointerId=event.pointerId;},true);
      function Harness(){
        const [hosts,setHosts]=useState(initialHosts);
        const [sessions,setSessions]=useState(initialSessions);
        const [selected,setSelected]=useState('alpha-1');
        const [visible,setVisible]=useState(true);
        const [transfers,setTransfers]=useState([]);
        const [queue,showQueue]=useState(false);
        Object.assign(state,{setTransfers,showQueue,setSessions,setHosts});
        state.hosts=hosts;state.sessions=sessions;state.select=setSelected;state.setVisible=setVisible;
        state.changeHost=(id,patch)=>setHosts(current=>current.map(host=>host.id===id?{...host,...patch}:host));
        state.disconnect=()=>setSessions(current=>current.map(session=>session.id===selected?{...session,status:'disconnected'}:session));
        return <><div style={{display:visible&&!queue?'block':'none'}}><FilesView transfers={transfers} session={sessions.find(session=>session.id===selected)} sessions={sessions} hosts={hosts} onSelectSession={setSelected}
          onConnectHost={(host,force,ready)=>{state.authRequested=host.id;state.authComplete=()=>{const id=host.id+'-new';setSessions(items=>[...items,{id,hostId:host.id,name:host.name,status:'connected'}]);ready(id);};}}
          onOpenTerminalHere={(id,path)=>state.terminalAction={id,path}}
          onInsertPath={(id,target,path)=>state.insertAction={id,target,path}}
          notify={(text,error)=>state.notifications.push({text,error})} onTransfer={openQueue=>state.transferCallbacks.push(openQueue)} theme='dark' defaultDirectory='' onDirtyChange={()=>{}} visible={visible&&!queue}/></div>
          {queue && <Transfers transfers={transfers} refresh={()=>{}} notify={()=>{}}/>}</>;
      }
      createRoot(document.getElementById('root')).render(<Harness/>);
    `,
    resolveDir: project,
    sourcefile: "files-drag-drop-fixture.tsx",
    loader: "tsx",
  },
  bundle: true, write: false, outdir: resolve(project, "../../work/files-drag-drop-fixture"),
  format: "iife", platform: "browser", jsx: "automatic",
  plugins: [{ name: "fixture-transport", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: "fixture-api", namespace: "fixture" }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({ path: "fixture-window", namespace: "fixture" }));
    builder.onLoad({ filter: /^fixture-api$/, namespace: "fixture" }, () => ({ contents: "export const desktop=true; export const request=(action,payload)=>window.fixture.request(action,payload);", loader: "js" }));
    builder.onLoad({ filter: /^fixture-window$/, namespace: "fixture" }, () => ({ contents: "export const getCurrentWindow=()=>({onDragDropEvent:listener=>{window.fixture.nativeListeners.add(listener);return Promise.resolve(()=>window.fixture.nativeListeners.delete(listener));},scaleFactor:()=>window.fixture.scaleFactor()});", loader: "js" }));
  } }],
});
const styles = [
  (await readFile(resolve(project, "src/styles.css"), "utf8")).replace(/^@import .*;$/gm, ""),
  await readFile(resolve(project, "src/polish.css"), "utf8"),
  ...compiled.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text),
];
const script = compiled.outputFiles.find(file => file.path.endsWith(".js")).text;
const server = createServer((_request, response) => response.end('<!doctype html><html lang="en"><head><title>VEXSSH file drag fixture</title></head><body><main id="root" style="overflow:auto"></main></body></html>'));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const reports = [];

const pane = (page, side) => page.locator(`[data-file-side="${side}"]`);
const file = (page, side, name = "one.txt") => pane(page, side).locator(".file-name").filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
const directoryPath = (page, side) => page.getByRole("textbox", { name: `${side} directory path`, exact: true });
const transfers = page => page.evaluate(() => window.fixture.calls.filter(call => call.action === "transfer_start").map(call => call.payload));
const center = async locator => {
  const box = await locator.boundingBox();
  assert(box, "Expected visible pointer target");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const background = async (page, side) => {
  const list = pane(page, side).locator(".file-list");
  const box = await list.boundingBox();
  assert(box);
  const point = { x: box.x + box.width / 2, y: box.y + box.height - 8 };
  assert(await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return !!target?.closest(".file-list") && !target.closest(".file-row,button,input,select");
  }, point), "Expected unoccupied list background");
  return point;
};
async function move(page, point) { await page.mouse.move(point.x, point.y, { steps: 12 }); }
async function begin(page, side = "local", name = "one.txt", expectGhost = true) {
  const source = file(page, side, name);
  await source.scrollIntoViewIfNeeded();
  const point = await center(source);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 12, point.y + 2, { steps: 3 });
  if (expectGhost) await expect(page.locator(".file-drag-ghost")).toBeVisible();
  return source;
}
async function drag(page, side, destination, name = "one.txt") {
  const originalPath = await directoryPath(page, side).inputValue();
  await begin(page, side, name);
  await move(page, typeof destination === "function" ? await destination() : destination);
  await page.mouse.up();
  await expect(page.locator(".file-drag-ghost")).toHaveCount(0);
  await expect(directoryPath(page, side)).toHaveValue(originalPath);
}
async function visit(page, side, path) {
  await directoryPath(page, side).fill(path);
  await directoryPath(page, side).press("Enter");
  await expect(pane(page, side).locator(".file-list")).toHaveAttribute("aria-busy", "false");
  await expect(directoryPath(page, side)).toHaveValue(path);
}
async function expectTransfers(page, expected) {
  if (!expected.length) await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(async () => (await transfers(page)).map(({batchId,...record})=>{
    assert.match(batchId,/^[\da-f-]{36}$/i);
    return record;
  })).toEqual(expected);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.action === "file_read").length), 0, "Dragging must not open a file");
}
const plan = (direction, source, destination, protocol = "sftp", sessionId = "alpha-1") => ({ sessionId, tabId:sessionId, source, destination, direction, protocol });
async function nativeDrop(page, point, paths = ["C:/Explorer/report.txt"]) {
  await page.evaluate(({ point, paths }) => window.fixture.emitNative("drop", { x: point.x * window.fixture.scale, y: point.y * window.fixture.scale }, paths), { point, paths });
}
async function run(name, exercise, options = {}) {
  if (process.env.VEXSSH_FILES_DRAG_FILTER && !new RegExp(process.env.VEXSSH_FILES_DRAG_FILTER).test(name)) return;
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...options });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const content of styles) await page.addStyleTag({ content });
    await page.addScriptTag({ content: script });
    await expect(directoryPath(page, "local")).toHaveValue("C:/local");
    await expect(directoryPath(page, "remote")).toHaveValue("/srv/shared");
    await expect.poll(() => page.evaluate(() => window.fixture.nativeListeners.size)).toBe(1);
    const details = await exercise(page);
    assert.deepEqual(errors, []);
    reports.push({ name, result: "PASS", ...details });
    console.log(JSON.stringify(reports.at(-1)));
  } catch (error) {
    console.log(JSON.stringify({ name, result: "FAIL", error: String(error), errors, transfers: await transfers(page), bodyText: (await page.locator("body").innerText()).slice(0, 2200) }, null, 2));
    await page.screenshot({ path: resolve(project, "../../work/files-drag-drop-failure.png"), fullPage: true });
    throw error;
  } finally { await page.close(); }
}

try {
  async function chooseLeft(page, name) {
    await page.getByRole("button", {name: /^Left endpoint,/}).click();
    const picker = page.getByRole("dialog", {name: "Choose left endpoint"});
    await picker.getByRole("button", {name: new RegExp(name)}).first().click();
    await expect(picker).toBeHidden();
  }
  const relay = (sourceSessionId, destinationSessionId, source, destination) => ({
    ...plan("relay", source, destination, "sftp", destinationSessionId), sourceSessionId,
  });
  await run("host-to-host drag, reverse selection and return to desktop", async page => {
    await chooseLeft(page, "Beta");
    await expect(directoryPath(page, "local")).toHaveValue("/srv/shared");
    await visit(page, "local", "/srv/beta");
    await visit(page, "remote", "/srv/alpha");
    await drag(page, "local", () => center(file(page, "remote", "docs")));
    const first = relay("beta-1", "alpha-1", "/srv/beta/one.txt", "/srv/alpha/docs/one.txt");
    await expectTransfers(page, [first]);
    await pane(page, "remote").getByRole("checkbox", {name: "Select docs", exact: true}).check();
    await pane(page, "remote").getByRole("checkbox", {name: "Select two.txt", exact: true}).check();
    await pane(page, "remote").getByRole("button", {name: "Copy to Beta", exact:true}).click();
    const reverse = ["docs", "two.txt"].map(name => relay("alpha-1", "beta-1", "/srv/alpha/" + name, "/srv/beta/" + name));
    await expectTransfers(page, [first, ...reverse]);
    await chooseLeft(page, "This computer");
    await expect(directoryPath(page, "local")).toHaveValue("C:/local");
    await expect(directoryPath(page, "remote")).toHaveValue("/srv/shared");
    await drag(page, "local", () => background(page, "remote"));
    await expectTransfers(page, [first, ...reverse, plan("upload", "C:/local/one.txt", "/srv/shared/one.txt")]);
  });
  await run("disconnected host-to-host source cannot start a pending drag", async page => {
    await chooseLeft(page, "Beta");
    await expect(directoryPath(page, "local")).toHaveValue("/srv/shared");
    await begin(page, "local");
    await page.evaluate(() => fixture.setSessions(items => items.map(item => item.id === "beta-1" ? {...item, status:"disconnected"} : item)));
    await move(page, await background(page, "remote"));
    await page.mouse.up();
    await expectTransfers(page, []);
    await expect(pane(page, "local").getByRole("button", {name: /^Copy to /})).toBeDisabled();
  });
  await run("host-to-host right picker keeps the left host and queue identifies both endpoints", async page => {
    await page.evaluate(() => {
      fixture.setHosts(items => [...items, {...items[0], id:"gamma", name:"Gamma", hostname:"gamma.example.invalid"}]);
      fixture.setSessions(items => [...items, {...items[0], id:"gamma-1", name:"Gamma", hostId:"gamma"}]);
    });
    await chooseLeft(page, "Beta");
    await page.getByRole("button", {name:"Remote server, Alpha. Choose server"}).click();
    const picker = page.getByRole("dialog", {name:"Choose remote server"});
    await expect(picker.getByRole("button", {name:/Beta/})).toHaveCount(0);
    await picker.getByRole("button", {name:/Gamma/}).first().click();
    await expect(page.getByRole("button", {name:"Left endpoint, Beta. Choose server"})).toBeVisible();
    await expect(page.getByRole("button", {name:"Remote server, Gamma. Choose server"})).toBeVisible();
    await visit(page, "local", "/srv/beta");
    await visit(page, "remote", "/srv/gamma");
    await drag(page, "local", () => background(page, "remote"));
    await expectTransfers(page, [relay("beta-1", "gamma-1", "/srv/beta/one.txt", "/srv/gamma/one.txt")]);
    await page.evaluate(() => {
      const {payload} = fixture.calls.find(call => call.action === "transfer_start");
      fixture.setTransfers([{...payload, id:"relay", sourceHostName:"Beta", destinationHostName:"Gamma",
        status:"completed", startedAt:1, totalBytes:4, transferredBytes:4}]);
      fixture.showQueue(true);
    });
    const row = page.locator(".transfer-row");
    await expect(row).toContainText("Beta · /srv/beta/one.txt");
    await expect(row).toContainText("→ Gamma · /srv/gamma/one.txt");
  });
  await run("session positions preserve both folders, selection, focus and scroll between same-host tabs", async page => {
    await page.evaluate(() => {
      fixture.overflowSide = "remote";
      fixture.setSessions(items => [...items, {...items[0], id:"alpha-2", name:"Logs"}]);
    });
    await visit(page,"local","C:/deploy");
    await visit(page,"remote","/releases");
    await pane(page,"local").getByRole("checkbox",{name:"Select two.txt"}).check();
    const select = n => pane(page,"remote").getByRole("checkbox",{name:"Select folder-"+n, exact:true});
    await select("27").check();
    const list = pane(page,"remote").locator(".file-list");
    const getScroll = () => list.evaluate(el => el.scrollTop);
    const scroll = await getScroll();
    assert(scroll > 0);
    await page.evaluate(() => fixture.select("alpha-2"));
    await visit(page,"local","C:/logs");
    await visit(page,"remote","/var/log");
    await pane(page,"local").getByRole("checkbox",{name:"Select one.txt"}).check();
    await select("09").check();
    await page.evaluate(() => fixture.select("alpha-1"));
    await expect(directoryPath(page,"local")).toHaveValue("C:/deploy");
    await expect(directoryPath(page,"remote")).toHaveValue("/releases");
    await expect(select("27")).toBeChecked();
    await expect(select("27")).toBeFocused();
    await expect(pane(page,"local").getByRole("checkbox",{name:"Select two.txt"})).toBeChecked();
    await expect.poll(getScroll).toBe(scroll);
    await page.evaluate(() => fixture.setVisible(false));
    await page.evaluate(() => fixture.select("alpha-2"));
    await page.evaluate(() => fixture.setVisible(true));
    await expect(directoryPath(page,"local")).toHaveValue("C:/logs");
    await expect(directoryPath(page,"remote")).toHaveValue("/var/log");
    await expect(select("09")).toBeChecked();
    await expect(select("09")).toBeFocused();
    await expect(pane(page,"local").getByRole("checkbox",{name:"Select one.txt"})).toBeChecked();
  });
  await run("session positions ignore stale local and remote navigation and bind reconnected tab", async page => {
    await page.evaluate(() => fixture.setSessions(items => [...items,{...items[0],id:"alpha-2",name:"Logs",tabId:"log-tab"}]));
    await visit(page,"local","C:/releases");
    await visit(page,"remote","/releases");
    await page.evaluate(() => {fixture.deferPath="C:/late";});
    await directoryPath(page,"local").fill("C:/late");
    await directoryPath(page,"local").press("Enter");
    await expect.poll(()=>page.evaluate(()=>typeof fixture.releaseList)).toBe("function");
    await page.evaluate(()=>{ fixture.completeOldLocal = fixture.releaseList; fixture.releaseList = null; fixture.deferPath="/late"; });
    await directoryPath(page,"remote").fill("/late");
    await directoryPath(page,"remote").press("Enter");
    await expect.poll(()=>page.evaluate(()=>typeof fixture.releaseList)).toBe("function");
    await page.evaluate(()=>fixture.select("alpha-2"));
    await visit(page,"local","C:/logs");
    await visit(page,"remote","/var/log");
    await page.evaluate(()=>{fixture.completeOldLocal();fixture.releaseList();});
    await expect(directoryPath(page,"local")).toHaveValue("C:/logs");
    await expect(directoryPath(page,"remote")).toHaveValue("/var/log");
    await pane(page,"remote").getByRole("checkbox",{name:"Select two.txt"}).check();
    await page.evaluate(()=>{
      fixture.setSessions(items=>items.map(s=>s.id==="alpha-2"?{...s,id:"alpha-new"}:s));
      fixture.select("alpha-new");
    });
    await expect(directoryPath(page,"remote")).toHaveValue("/var/log");
    await expect(pane(page,"remote").getByRole("checkbox",{name:"Select two.txt"})).toBeChecked();
    await expect.poll(()=>page.evaluate(()=>fixture.calls.some(c=>c.action==="file_list" && c.payload.sessionId==="alpha-new" && c.payload.path==="/var/log"))).toBe(true);
    await page.evaluate(()=>fixture.select("alpha-1"));
    await expect(directoryPath(page,"local")).toHaveValue("C:/releases");
    await expect(directoryPath(page,"remote")).toHaveValue("/releases");
  });
  await run("session positions cancel pending editor when switching modes and preserve a dirty bound editor", async page => {
    await page.evaluate(() => {
      const request = fixture.request;
      let hold = true;
      fixture.request = (action, payload) => {
        if (action === "file_read" && hold) {
          hold = false;
          return new Promise(resolve => { fixture.finishOpen = () => resolve({content:"old", revision:"v1"}); });
        }
        return request(action, payload);
      };
    });
    await file(page,"remote","one.txt").dblclick();
    await expect.poll(() => page.evaluate(() => typeof fixture.finishOpen)).toBe("function");
    await page.evaluate(() => fixture.setVisible(false));
    await expect(pane(page,"remote")).toBeHidden();
    await page.evaluate(() => fixture.setVisible(true));
    await expect(pane(page,"remote")).toBeVisible();
    await page.evaluate(() => fixture.finishOpen());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await file(page,"remote","two.txt").dblclick();
    const editor = page.getByRole("dialog",{name:"two.txt",exact:true});
    await expect(editor).toBeVisible();
    await editor.locator(".cm-content").click();
    await page.keyboard.insertText("keep-this-draft");
    await expect(editor).toContainText("Unsaved changes");
    await page.evaluate(() => fixture.select("beta-1"));
    await expect(editor).toContainText("keep-this-draft");
    await editor.getByRole("button",{name:"Save with backup"}).click();
    await expect.poll(() => page.evaluate(() => fixture.calls.filter(c=>c.action==="file_save").map(c=>c.payload.sessionId))).toEqual(["alpha-1"]);
  });
  await run("workspace inline progress and exact destination refresh", async page => {
    const job = {id:"a",direction:"upload",sessionId:"alpha-1",source:"C:/local/done.zip",destination:"/srv/shared/done.zip",status:"running",protocol:"sftp",startedAt:1,totalBytes:100,transferredBytes:35,speedBytesPerSecond:5,etaSeconds:13};
    await page.evaluate(job=>fixture.setTransfers([job,{...job,id:"wrong",sessionId:"beta-1",destination:"/srv/shared/other.zip"}]),job);
    await expect(page.getByRole("progressbar",{name:"Transfer progress for done.zip"})).toBeVisible();
    await expect(page.locator(".file-inline-transfer")).toHaveCount(1);
    await expect(page.locator(".file-inline-transfer")).toContainText("35%");
    const calls = () => page.evaluate(()=>fixture.calls.filter(c=>c.action==="file_list" && c.payload.side==="remote").length);
    const before = await calls();
    await page.evaluate(job=>{fixture.finished=true;fixture.setTransfers([{...job,status:"completed",finishedAt:3}]);},job);
    await expect(file(page,"remote","done.zip")).toBeVisible();
    await expect(page.locator(".file-inline-transfer")).toHaveCount(0);
    assert.equal(await calls(), before+1);
    await visit(page,"remote","/other"); const changed=await calls();
    await page.evaluate(job=>fixture.setTransfers([{...job,id:"another",status:"completed",finishedAt:5}]),job);
    await page.waitForTimeout(120);
    assert.equal(await calls(),changed);
  });
  await run("workspace file context targets current folder and matching terminal", async page => {
    await file(page,"remote","docs").click({button:"right"});
    await page.getByRole("menuitem",{name:"Open terminal here"}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.terminalAction),{id:"alpha-1",path:"/srv/shared/docs"});
    await page.evaluate(()=>fixture.setSessions(list=>[...list,{...list[0],id:"alpha-2",name:"Alpha · 2"}]));
    await file(page,"remote","two.txt").click({button:"right"});
    await page.getByRole("menuitem",{name:"Insert path into terminal"}).click();
    const dialog=page.getByRole("dialog",{name:"Insert path into terminal"});
    await expect(dialog.getByRole("button",{name:"Beta"})).toHaveCount(0);
    await dialog.getByRole("button",{name:"Alpha · 2"}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.insertAction),{id:"alpha-1",target:"alpha-2",path:"/srv/shared/two.txt"});
    await page.mouse.click(...Object.values(await background(page,"remote")),{button:"right"});
    await page.getByRole("menuitem",{name:"Open terminal here"}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.terminalAction),{id:"alpha-1",path:"/srv/shared"});
  });
  await run("workspace saved pairs across sessions and authenticated reconnect", async page => {
    await visit(page,"local","C:/key"); await visit(page,"remote","/home/key");
    const pairs=page.getByRole("button",{name:"Folder pairs",exact:true});
    await pairs.click(); await page.getByLabel("Pair name").fill("Keysafe"); await page.getByRole("button",{name:"Save current pair"}).click();
    await expect(page.getByRole("button",{name:/^Keysafe/})).toBeVisible();
    await page.getByRole("button",{name:"Close dialog"}).click();
    await page.evaluate(()=>fixture.select("beta-1")); await visit(page,"local","C:/elsewhere");
    await pairs.click(); await page.getByRole("button",{name:/^Keysafe/}).click();
    await expect(directoryPath(page,"remote")).toHaveValue("/home/key"); await expect(directoryPath(page,"local")).toHaveValue("C:/key");
    await page.evaluate(()=>{fixture.disconnect();fixture.select("beta-1");}); await visit(page,"local","C:/elsewhere");
    await pairs.click(); await page.getByRole("button",{name:/^Keysafe/}).click();
    await expect.poll(()=>page.evaluate(()=>fixture.authRequested)).toBe("alpha");
    await expect(directoryPath(page,"local")).toHaveValue("C:/elsewhere");
    await page.evaluate(()=>fixture.authComplete()); await expect(directoryPath(page,"remote")).toHaveValue("/home/key");
    await expect(directoryPath(page,"local")).toHaveValue("C:/key");
    await page.evaluate(()=>fixture.changeHost("alpha",{hostname:"changed.example.invalid"})); await pairs.click();
    await expect(page.getByRole("button",{name:/^Keysafe/})).toBeDisabled();
    await page.getByRole("button",{name:"Remove folder pair Keysafe"}).click(); await expect(page.getByRole("button",{name:/^Keysafe/})).toHaveCount(0);
  });
  await run("workspace log follow pause search copy and close", async page => {
    await page.evaluate(()=>fixture.logChunks=["first\n","WARN disk\n"]);
    await file(page,"remote","one.txt").click({button:"right"}); await page.getByRole("menuitem",{name:"Watch log"}).click();
    const log=page.getByRole("complementary",{name:"Live log viewer"});
    await expect(log.getByRole("button",{name:"WARN disk"})).toBeVisible();
    await log.getByRole("button",{name:"Pause",exact:true}).click(); await page.evaluate(()=>fixture.logChunks.push("appended\n"));
    await page.waitForTimeout(1200); await expect(log.getByRole("button",{name:"appended"})).toHaveCount(0);
    await log.getByRole("button",{name:"Resume",exact:true}).click(); await expect(log.getByRole("button",{name:"appended"})).toBeVisible();
    await page.evaluate(()=>fixture.setVisible(false)); await expect(log).toBeVisible();
    await log.getByRole("textbox",{name:"Search log lines"}).fill("warn");
    await expect(log.getByRole("button",{name:"first",exact:true})).toHaveCount(0);
    await log.getByRole("button",{name:"WARN disk"}).click(); await log.getByRole("button",{name:"Copy line"}).click();
    await expect.poll(()=>page.evaluate(()=>fixture.clip)).toBe("WARN disk");
    await log.getByRole("button",{name:"Close log viewer"}).click(); await expect(log).toHaveCount(0);
    assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.action==="file_tail_close").length),1);
  });
  await run("workspace conflict decisions resume and restart", async page => {
    const job={id:"x",direction:"upload",sessionId:"alpha-1",source:"C:/local/one.txt",destination:"/srv/shared/one.txt",protocol:"sftp",status:"conflict",startedAt:1,totalBytes:9,transferredBytes:4,speedBytesPerSecond:0,etaSeconds:null,
      conflict:{token:"c",source:"C:/local/one.txt",destination:"/srv/shared/one.txt",sourceSize:9,destinationSize:11,sourceModified:100000,destinationModified:100010,canReplace:false}};
    await page.evaluate(job=>fixture.setTransfers([job]),job);
    const dialog=page.getByRole("dialog",{name:"Destination already exists"});
    await expect(dialog).toContainText("C:/local/one.txt");
    await expect(dialog.getByRole("button",{name:"Replace",exact:true})).toBeDisabled();
    await dialog.getByRole("checkbox").check(); await dialog.getByRole("button",{name:"Keep both"}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.calls.find(c=>c.action==="transfer_resolve").payload),{id:"x",token:"c",choice:"keepBoth",applyToAll:true});
    for(const [choice, label] of [["skip","Skip"], ["replace","Replace"]]){
      await page.evaluate(({job,choice})=>fixture.setTransfers([{...job,conflict:{...job.conflict,token:choice,canReplace:true}}]),{job,choice});
      await dialog.getByRole("button",{name:label,exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(c=>c.action==="transfer_resolve").at(-1).payload),
        {id:"x",token:choice,choice,applyToAll:false});
    }
    await page.evaluate(job=>{fixture.setTransfers([{...job,status:"failed",conflict:null,resumable:true}]);fixture.showQueue(true);},job);
    await page.getByRole("button",{name:"Resume",exact:true}).click();
    await page.getByRole("button",{name:"Restart",exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(c=>["transfer_retry","transfer_resume"].includes(c.action)).map(c=>[c.action,c.payload.id])),[["transfer_resume","x"],["transfer_retry","x"]]);
  });
  for (const direction of ["upload", "download"]) {
    const sourceSide = direction === "upload" ? "local" : "remote";
    const targetSide = direction === "upload" ? "remote" : "local";
    const sourceBase = direction === "upload" ? "C:/local" : "/srv/shared";
    const targetBase = direction === "upload" ? "/srv/shared" : "C:/local";
    for (const targetKind of ["current", "folder"]) {
      await run(`${direction} to ${targetKind} directory`, async page => {
        await page.evaluate(() => fixture.setSessions(items => items.map(s => s.id === "alpha-1" ? {...s, name:"Release"} : s)));
        await expect(pane(page,"remote").getByRole("button",{name:"Remote server, Release · Alpha. Choose server"})).toBeVisible();
        await expect(pane(page,"remote").locator(".host-mark")).toHaveCSS("background-color","rgb(108, 140, 255)");
        await begin(page, sourceSide);
        await move(page, targetKind === "folder" ? await center(file(page, targetSide, "docs")) : await background(page, targetSide));
        const ghost = page.locator(".file-drag-ghost");
        await expect(ghost.locator("strong")).toHaveText(direction === "upload" ? "Upload 1 item to Alpha" : "Download 1 item to This computer");
        await expect(ghost.locator("span")).toHaveText(targetBase + (targetKind === "folder" ? "/docs" : ""));
        await expect(pane(page,targetSide).locator(targetKind === "folder" ? ".file-row.drop-target" : ".file-list.file-drop-target")).toBeVisible();
        assert.deepEqual(await transfers(page), []);
        await page.mouse.up();
        await expectTransfers(page, [plan(direction, `${sourceBase}/one.txt`, `${targetBase}${targetKind === "folder" ? "/docs" : ""}/one.txt`)]);
        await expect.poll(() => page.evaluate(() => window.fixture.transferCallbacks)).toEqual([false]);
      });
    }
  }
  await run("multi-selection copies all selected entries with SCP", async page => {
    await pane(page, "local").getByRole("checkbox", { name: "Select one.txt", exact: true }).check();
    await pane(page, "local").getByRole("checkbox", { name: "Select two.txt", exact: true }).check();
    await page.locator(".inline-field select").selectOption("scp");
    await drag(page, "local", () => background(page, "remote"));
    await expectTransfers(page, ["one.txt", "two.txt"].map(name => plan("upload", `C:/local/${name}`, `/srv/shared/${name}`, "scp")));
    await expect(pane(page, "local").getByRole("checkbox", { name: "Select one.txt", exact: true })).toBeChecked();
    await expect(pane(page, "local").getByRole("checkbox", { name: "Select two.txt", exact: true })).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.fixture.transferCallbacks)).toEqual([false]);
  });
  await run("dragging an unselected file does not transfer the checked file", async page => {
    await pane(page, "local").getByRole("checkbox", { name: "Select one.txt", exact: true }).check();
    await drag(page, "local", () => background(page, "remote"), "two.txt");
    await expectTransfers(page, [plan("upload", "C:/local/two.txt", "/srv/shared/two.txt")]);
  });
  await run("directory source uses existing recursive transfer queue", async page => {
    await drag(page, "local", () => center(file(page, "remote", "docs")), "docs");
    await expectTransfers(page, [plan("upload", "C:/local/docs", "/srv/shared/docs/docs")]);
  });
  for (const target of ["same side", "file row", "parent directory button", "header", "outside"]) {
    await run(`reject ${target} target`, async page => {
      await begin(page);
      const point = target === "same side" ? await background(page, "local")
        : target === "file row" ? await center(file(page, "remote", "two.txt"))
          : target === "parent directory button" ? await center(pane(page, "remote").getByRole("button", { name: "Parent directory", exact: true }))
            : target === "header" ? await center(pane(page, "remote").locator(".file-pane-header"))
              : { x: 3, y: 3 };
      await move(page, point);
      await expect(page.locator(".file-drop-target,.file-row.drop-target")).toHaveCount(0);
      await page.mouse.up();
      await expectTransfers(page, []);
      await expect(page.locator(".file-drag-ghost")).toHaveCount(0);
    });
  }
  for (const cancel of ["Escape", "pointercancel", "lost capture", "blur", "hidden", "local navigation", "remote navigation", "refresh", "server switch", "disconnect", "profile change"]) {
    await run(`${cancel} cancels drag without redirecting identical server paths`, async page => {
      const source = await begin(page, "remote");
      const target = await background(page, "local");
      await move(page, target);
      if (cancel === "Escape") await page.keyboard.press("Escape");
      if (cancel === "pointercancel") await source.dispatchEvent("pointercancel", { pointerId: await page.evaluate(() => window.fixture.pointerId), bubbles: true });
      if (cancel === "lost capture") {
        assert(await page.evaluate(() => {
          const captor = [...document.querySelectorAll("[data-file-side], [data-file-side] *")].find(element => element.hasPointerCapture(window.fixture.pointerId));
          captor?.releasePointerCapture(window.fixture.pointerId);
          return !!captor;
        }), "Pointer drag must capture its pointer");
        await page.mouse.move(target.x + 1, target.y);
      }
      if (cancel === "blur") await page.evaluate(() => dispatchEvent(new Event("blur")));
      if (cancel === "hidden") await page.evaluate(() => window.fixture.setVisible(false));
      if (cancel === "local navigation") await visit(page, "local", "C:/local/docs");
      if (cancel === "remote navigation") await visit(page, "remote", "/srv/shared/docs");
      if (cancel === "refresh") await pane(page, "remote").getByRole("button", { name: "Refresh remote directory", exact: true }).evaluate(button => button.click());
      if (cancel === "server switch") {
        await page.evaluate(() => window.fixture.select("beta-1"));
        await expect(pane(page, "remote").getByRole("button", { name: "Remote server, Beta. Choose server", exact: true })).toBeVisible();
        await expect(directoryPath(page, "remote")).toHaveValue("/srv/shared");
      }
      if (cancel === "disconnect") await page.evaluate(() => window.fixture.disconnect());
      if (cancel === "profile change") await page.evaluate(() => window.fixture.changeHost("alpha", { hostname: "replacement.example.invalid" }));
      await expect(page.locator(".file-drag-ghost")).toHaveCount(0);
      await move(page, target);
      await page.mouse.up();
      await expectTransfers(page, []);
    });
  }
  for (const state of ["busy", "error"]) {
    await run(`${state} listing prevents internal drag and native drop`, async page => {
      await page.evaluate(state => { window.fixture[state === "busy" ? "deferPath" : "failPath"] = "/srv/shared/unavailable"; }, state);
      await directoryPath(page, "remote").fill("/srv/shared/unavailable");
      await directoryPath(page, "remote").press("Enter");
      if (state === "busy") await expect(pane(page, "remote").locator(".file-list")).toHaveAttribute("aria-busy", "true");
      else await expect(pane(page, "remote").getByRole("alert")).toContainText("Fixture listing unavailable");
      await begin(page, "local", "one.txt", false);
      const target = await background(page, "remote");
      await move(page, target);
      await page.mouse.up();
      await nativeDrop(page, target);
      await expectTransfers(page, []);
      await expect(page.locator(".file-drag-ghost")).toHaveCount(0);
    });
  }
  await run("accepted multi-file batch remains pinned while requests await", async page => {
    await pane(page, "local").getByRole("checkbox", { name: "Select all local files", exact: true }).check();
    await page.evaluate(() => { window.fixture.holdTransfer = true; });
    await drag(page, "local", () => center(file(page, "remote", "docs")));
    await expect.poll(async () => (await transfers(page)).length).toBe(1);
    await page.evaluate(() => { window.fixture.select("beta-1"); });
    await expect(directoryPath(page, "remote")).toHaveValue("/srv/shared");
    await visit(page, "remote", "/srv/shared/elsewhere");
    await page.locator(".inline-field select").selectOption("scp");
    await page.evaluate(() => { window.fixture.holdTransfer = false; window.fixture.pendingTransfers.shift()(); });
    await expectTransfers(page, ["docs", "one.txt", "two.txt"].map(name => plan("upload", `C:/local/${name}`, `/srv/shared/docs/${name}`)));
    await expect.poll(() => page.evaluate(() => window.fixture.transferCallbacks)).toEqual([false]);
  });
  await run("partial queue failure refreshes transfers once without opening queue", async page => {
    await pane(page, "local").getByRole("checkbox", { name: "Select all local files", exact: true }).check();
    await page.evaluate(() => { window.fixture.failTransferAt = 2; });
    await drag(page, "local", () => background(page, "remote"));
    await expect.poll(async () => (await transfers(page)).length).toBe(2);
    await expect.poll(() => page.evaluate(() => window.fixture.transferCallbacks)).toEqual([false]);
    assert((await page.evaluate(() => window.fixture.notifications)).some(entry => entry.error && entry.text.includes("Fixture queue unavailable")));
  });
  await run("click double-click checkbox and keyboard transfer remain usable", async page => {
    await file(page, "local").click();
    await expect(pane(page, "local").getByRole("checkbox", { name: "Select one.txt", exact: true })).toBeChecked();
    await pane(page, "local").getByRole("checkbox", { name: "Select two.txt", exact: true }).check();
    await expect(pane(page, "local").getByRole("checkbox", { name: "Select one.txt", exact: true })).toBeChecked();
    const upload = pane(page, "local").getByRole("button", { name: "Upload", exact: true });
    await upload.focus(); await page.keyboard.press("Enter");
    await expect.poll(async () => (await transfers(page)).length).toBe(2);
    await file(page, "remote").click();
    const download = pane(page, "remote").getByRole("button", { name: "Download", exact: true });
    await download.focus(); await page.keyboard.press("Enter");
    await expect.poll(async () => (await transfers(page)).length).toBe(3);
    await file(page, "local", "docs").dblclick();
    await expect(directoryPath(page, "local")).toHaveValue("C:/local/docs");
    assert.deepEqual(await page.evaluate(() => window.fixture.transferCallbacks), [undefined, undefined]);
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.action === "file_read").length), 0);
  });
  for (const destination of ["current", "folder"]) {
    await run(`native Explorer upload to ${destination} at scale 2`, async page => {
      await page.evaluate(() => { window.fixture.scale = 2; });
      const target = destination === "folder" ? await center(file(page, "remote", "docs")) : await background(page, "remote");
      await page.evaluate(({x,y}) => fixture.emitNative("enter",{x:x*2,y:y*2},["C:/Explorer/report.txt", "C:\\Explorer\\second.txt"]), target);
      await expect(page.locator(".file-native-drop-hint")).toContainText("Upload 2 items to Alpha");
      await expect(page.locator(".file-native-drop-hint span")).toHaveText("/srv/shared" + (destination === "folder" ? "/docs" : ""));
      await expect(pane(page,"remote").locator(destination === "folder" ? ".file-row.drop-target" : ".file-list.file-drop-target")).toBeVisible();
      await nativeDrop(page, target, ["C:/Explorer/report.txt", "C:\\Explorer\\second.txt"]);
      await expectTransfers(page, [plan("upload", "C:/Explorer/report.txt", `/srv/shared${destination === "folder" ? "/docs" : ""}/report.txt`), plan("upload", "C:\\Explorer\\second.txt", `/srv/shared${destination === "folder" ? "/docs" : ""}/second.txt`)]);
      await expect.poll(() => page.evaluate(() => window.fixture.transferCallbacks)).toEqual([false]);
    });
  }
  for (const origin of ["Explorer", "local panel"]) {
    await run(`${origin} uploads multiple folders onto the remote path bar above a full list`, async page => {
      const destination = "/srv/shared/releases";
      await page.evaluate(() => { window.fixture.overflowSide = "remote"; });
      await visit(page, "remote", destination);
      await expect(pane(page, "remote").locator(".file-row")).toHaveCount(40);
      const target = await center(directoryPath(page, "remote"));
      const names = ["folder-01", "folder-02"];
      const source = origin === "Explorer" ? "C:/Explorer" : "C:/local";
      const paths = names.map(name => `${source}/${name}`);
      if (origin === "Explorer") {
        await page.evaluate(({target, paths}) => {
          fixture.scale = 1.5;
          fixture.emitNative("enter", { x: target.x * fixture.scale, y: target.y * fixture.scale }, paths);
        }, {target, paths});
      } else {
        await page.evaluate(() => { window.fixture.overflowSide = "local"; });
        await pane(page, "local").getByRole("button", {name: "Refresh local directory", exact: true}).click();
        for (const name of names) {
          await pane(page, "local").getByRole("checkbox", {name: `Select ${name}`, exact: true}).check();
        }
        await begin(page, "local", names[0]);
        await move(page, target);
      }
      const preview = page.locator(origin === "Explorer" ? ".file-native-drop-hint" : ".file-drag-ghost");
      await expect(preview.locator("strong")).toHaveText("Upload 2 items to Alpha");
      await expect(preview.locator("span")).toHaveText(destination);
      await expect(pane(page, "remote").locator(".path-bar")).toHaveClass(/file-drop-target/);
      if (origin === "Explorer") await nativeDrop(page, target, paths);
      else await page.mouse.up();
      await expectTransfers(page, names.map((name, i) => plan("upload", paths[i], `${destination}/${name}`)));
      assert.equal(new Set((await transfers(page)).map(t => t.batchId)).size, 1);
      await expect(directoryPath(page, "remote")).toHaveValue(destination);
    });
    await run(`${origin} rejects an edited remote path before navigation`, async page => {
      const field = directoryPath(page, "remote");
      await field.fill("/different/folder");
      const target = await center(field);
      if (origin === "Explorer") await nativeDrop(page, target);
      else await drag(page, "local", target);
      await expectTransfers(page, []);
      await expect(field).toHaveValue("/different/folder");
    });
  }
  for (const target of ["local", "file", "control", "outside", "disconnect"]) {
    await run(`native Explorer rejects ${target} target`, async page => {
      const point = target === "local" ? await background(page, "local")
        : target === "file" ? await center(file(page, "remote"))
          : target === "control" ? await center(pane(page, "remote").getByRole("button", { name: "Parent directory", exact: true }))
            : target === "outside" ? { x: 2, y: 2 } : await background(page, "remote");
      if (target === "disconnect") { await page.evaluate(() => window.fixture.disconnect()); await expect.poll(() => page.evaluate(() => window.fixture.nativeListeners.size)).toBe(0); }
      await nativeDrop(page, point);
      await expectTransfers(page, []);
    });
  }
  await run("Explorer never redirects an advertised upload after a server switch", async page => {
    const point = await center(file(page,"remote","docs"));
    await page.evaluate(point=>fixture.emitNative("enter", point, ["C:/Explorer/report.txt"]), point);
    await expect(page.locator(".file-native-drop-hint")).toContainText("Alpha");
    await page.evaluate(()=>fixture.select("beta-1"));
    await expect(pane(page,"remote").getByRole("button",{name:"Remote server, Beta. Choose server"})).toBeVisible();
    await expect(page.locator(".file-native-drop-hint")).toHaveCount(0);
    await nativeDrop(page, await center(file(page,"remote","docs")));
    await expectTransfers(page, []);
  });
  for (const change of ["navigation", "server switch"]) {
    await run(`native scale-factor await cancels after ${change}`, async page => {
      const target = await background(page, "remote");
      await page.evaluate(() => { window.fixture.holdScale = true; });
      await nativeDrop(page, target);
      await expect.poll(() => page.evaluate(() => window.fixture.pendingScales.length)).toBe(1);
      if (change === "navigation") await visit(page, "remote", "/srv/shared/docs");
      else { await page.evaluate(() => window.fixture.select("beta-1")); await expect(pane(page, "remote").getByRole("button", { name: "Remote server, Beta. Choose server", exact: true })).toBeVisible(); }
      await page.evaluate(() => { window.fixture.holdScale = false; window.fixture.pendingScales.shift()(); });
      await expectTransfers(page, []);
    });
  }
  await run("overflowing target list autoscroll stops after cancellation", async page => {
    await page.evaluate(() => { window.fixture.overflowSide = "remote"; });
    await pane(page, "remote").getByRole("button", { name: "Refresh remote directory", exact: true }).click();
    await expect(pane(page, "remote").locator(".file-row")).toHaveCount(40);
    const list = pane(page, "remote").locator(".file-list");
    assert(await list.evaluate(element => element.scrollHeight > element.clientHeight));
    await list.scrollIntoViewIfNeeded();
    await begin(page);
    const box = await list.boundingBox();
    assert(box.y + box.height - 10 < page.viewportSize().height, "Autoscroll edge must be inside the viewport");
    await move(page, { x: box.x + box.width / 2, y: box.y + box.height - 10 });
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    const stoppedAt = await list.evaluate(element => element.scrollTop);
    await page.evaluate(() => new Promise(resolve => {
      let frames = 4;
      const next = () => --frames ? requestAnimationFrame(next) : resolve();
      requestAnimationFrame(next);
    }));
    assert.equal(await list.evaluate(element => element.scrollTop), stoppedAt);
    await expect(page.locator(".file-drag-ghost,.file-drop-target,.file-row.drop-target")).toHaveCount(0);
    await expectTransfers(page, []);
    return { stoppedAt };
  });
  for (const change of ["list scroll", "page scroll", "ancestor scroll", "filter", "sort"]) {
    await run(`native delayed scale rejects changed ${change}`, async page => {
      await page.evaluate(() => { window.fixture.overflowSide = "remote"; });
      await pane(page, "remote").getByRole("button", { name: "Refresh remote directory", exact: true }).click();
      await expect(pane(page, "remote").locator(".file-row")).toHaveCount(40);
      if (change === "ancestor scroll") await page.locator("#root").evaluate(element => { element.style.height = "520px"; element.style.overflow = "auto"; });
      if (change === "page scroll") await page.addStyleTag({content:"html,body{height:auto;overflow:visible} #root{position:static;overflow:visible!important}"});
      await file(page, "remote", "folder-01").scrollIntoViewIfNeeded();
      const target = await center(file(page, "remote", "folder-01"));
      await page.evaluate(() => { window.fixture.holdScale = true; });
      await nativeDrop(page, target);
      await expect.poll(() => page.evaluate(() => window.fixture.pendingScales.length)).toBe(1);
      if (change === "list scroll") {
        const previous = await pane(page, "remote").locator(".file-list").evaluate(element => element.scrollTop);
        await pane(page, "remote").locator(".file-list").evaluate(element => { element.scrollTop += 80; });
        assert(await pane(page, "remote").locator(".file-list").evaluate(element => element.scrollTop) > previous);
      }
      if (change === "page scroll") {
        const previous = await page.evaluate(() => scrollY);
        await page.evaluate(() => scrollBy(0, 60));
        assert(await page.evaluate(() => scrollY) > previous);
      }
      if (change === "ancestor scroll") {
        const previous = await page.locator("#root").evaluate(element => element.scrollTop);
        await page.locator("#root").evaluate(element => { element.scrollTop += 70; });
        assert(await page.locator("#root").evaluate(element => element.scrollTop) > previous);
      }
      if (change === "filter") {
        await pane(page, "remote").getByRole("textbox", { name: "Search remote files", exact: true }).fill("folder-02");
        await expect(pane(page, "remote").locator(".file-row")).toHaveCount(1);
      }
      if (change === "sort") {
        await pane(page, "remote").getByRole("combobox", { name: "Sort remote files", exact: true }).selectOption("size");
        await expect(pane(page, "remote").locator(".file-row").first()).toHaveAttribute("data-file-path", "/srv/shared/folder-40");
      }
      await page.evaluate(() => { window.fixture.holdScale = false; window.fixture.pendingScales.shift()(); });
      await expectTransfers(page, []);
    }, { viewport: { width: 1400, height: 560 } });
  }
  for (const theme of ["dark", "light"]) {
    await run(`${theme} minimum-width drag preview`, async page => {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await begin(page, "remote");
      await pane(page, "local").locator(".file-list").scrollIntoViewIfNeeded();
      const target = await center(file(page, "local", "docs"));
      await move(page, target);
      await expect(pane(page, "local").locator(".file-row.drop-target")).toHaveCount(1);
      await expect(page.locator(".file-drag-ghost")).toBeVisible();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
      const style = await page.locator(".file-drag-ghost").evaluate(element => { const value = getComputedStyle(element); return { foreground: value.color, muted: getComputedStyle(element.querySelector("span")).color, background: value.backgroundColor, opacity: value.opacity }; });
      const targetStyle = await pane(page, "local").locator(".file-row.drop-target").evaluate(element => {
        const style = getComputedStyle(element);
        let list = element.closest(".file-list");
        while (list && getComputedStyle(list).backgroundColor === "rgba(0, 0, 0, 0)") list = list.parentElement;
        return { outline: style.outlineColor, selected: style.backgroundColor, list: getComputedStyle(list).backgroundColor };
      });
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const contrast = (foreground, background) => {
        const first = luminance(foreground), second = luminance(background);
        return Number(((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)).toFixed(2));
      };
      const ratios = { heading: contrast(style.foreground, style.background), muted: contrast(style.muted, style.background), outlineSelected: contrast(targetStyle.outline, targetStyle.selected), outlineList: contrast(targetStyle.outline, targetStyle.list) };
      assert(ratios.heading >= 4.5, `Drag heading contrast ${ratios.heading}:1`);
      assert(ratios.muted >= 4.5, `Drag muted text contrast ${ratios.muted}:1`);
      assert(ratios.outlineSelected >= 3, `Selected-row drop outline contrast ${ratios.outlineSelected}:1`);
      assert(ratios.outlineList >= 3, `List drop outline contrast ${ratios.outlineList}:1`);
      assert.equal(style.opacity, "1");
      await page.screenshot({ path: resolve(project, `../../work/files-drag-drop-${theme}-760.png`) });
      await page.keyboard.press("Escape"); await page.mouse.up();
      await expectTransfers(page, []);
      return { contrast: ratios, noHorizontalOverflow: true };
    }, { viewport: { width: 760, height: 560 } });
  }
  console.log(JSON.stringify({ result: "PASS", count: reports.length, scenarios: reports.map(report => report.name), nativeTransport: "fixture", liveConnections: 0 }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
