import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const project = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const { build } = require("esbuild");
const { chromium, expect } = require("@playwright/test");
const compiled = await build({
  stdin: { contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FilesView} from './src/Files';
    const initialHosts=['alpha','beta'].map(id=>({id,name:id==='alpha'?'Alpha':'Beta',hostname:id+'.example.invalid',username:'core',port:22,workspaceId:'test',authMethod:'key',keySource:'file',identityFile:'fixture-key',tags:[],color:'#6C8CFF',notes:'',favorite:false,environmentLabel:id==='alpha'?'production':'lab'}));
    const initialSessions=[{id:'alpha-1',hostId:'alpha',name:'Alpha',status:'connected',latencyMs:1},{id:'beta-1',hostId:'beta',name:'Beta',status:'connected',latencyMs:1}];
    const state=window.fixture={calls:[],notifications:[],failPath:null,deferPath:null,deleted:new Set(),denyDelete:null};
    const item=(base,name,size=1,isDir=false)=>({name,path:base+'/'+name,size,isDir,isSymlink:false,modified:1,permissions:'644'});
    state.request=async(action,payload)=>{
      state.calls.push({action,payload});
      if(action==='file_list'){
        const session=state.sessions.find(session=>session.id===payload.sessionId);
        const host=state.hosts.find(host=>host.id===session?.hostId);
        const base=payload.side==='local'?'C:/local':'/srv/'+host.hostname.split('.')[0];
        const path=!payload.path||payload.path==='.'?base:payload.path;
        const entries=path.endsWith('/empty')?[]:[item(path,'docs',4096,true),item(path,'empty',4096,true),item(path,'shared.txt',4),item(path,'changed.txt',payload.side==='local'?2:3),item(path,payload.side==='local'?'local-only.txt':'remote-only.txt')];
        const result={path,entries:entries.filter(entry=>!state.deleted.has(entry.path))};
        if(state.failPath===path) throw new Error('Fixture folder access denied');
        if(state.deferPath===path){state.deferPath=null;return new Promise(resolve=>state.release=()=>resolve(result));}
        return result;
      }
      if(action==='file_delete'){
        if(payload.path===state.denyDelete) throw new Error('Fixture deletion denied');
        if(state.deleted.has(payload.path)) throw new Error('Already removed');
        state.deleted.add(payload.path);
      }
      if(action==='file_read') return {content:'original',revision:'old'};
      if(action==='file_save') return {revision:'new',backupPath:payload.path+'.bak'};
      return {ok:true};
    };
    function Harness(){
      const [hosts,setHosts]=useState(initialHosts);
      const [sessions,setSessions]=useState(initialSessions);
      const [selected,setSelected]=useState('alpha-1');
      const [generation,setGeneration]=useState(0);
      state.hosts=hosts;state.sessions=sessions;state.select=setSelected;
      state.remount=()=>setGeneration(value=>value+1);
      state.changeHost=(id,patch)=>setHosts(current=>current.map(host=>host.id===id?{...host,...patch}:host));
      state.restoreDisconnected=()=>{setSessions(current=>current.map(session=>session.hostId==='alpha'?{...session,status:'disconnected'}:session));setSelected('alpha-1');setGeneration(value=>value+1);};
      state.reconnect=()=>{const id='alpha-'+crypto.randomUUID();setSessions(current=>[...current.filter(session=>session.hostId!=='alpha'),{id,hostId:'alpha',name:'Alpha',status:'connected',latencyMs:1}]);setSelected(id);};
      return <FilesView key={generation} session={sessions.find(session=>session.id===selected)} sessions={sessions} hosts={hosts} onSelectSession={setSelected} onConnectHost={()=>{}} notify={text=>state.notifications.push(text)} onTransfer={()=>{}} theme='dark' defaultDirectory='' onDirtyChange={()=>{}} visible />;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `, resolveDir: project, sourcefile: "files-navigation-fixture.tsx", loader: "tsx" },
  bundle: true, write: false, outdir: resolve(project, "../../work/files-navigation-fixture"), format: "iife", platform: "browser", jsx: "automatic",
  plugins: [{ name: "fixture-api", setup(builder) {
    builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: "fixture-api", namespace: "fixture-api" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-api" }, () => ({ contents: "export const desktop=false; export const request=(action,payload)=>window.fixture.request(action,payload);", loader: "js" }));
  } }],
});
const server = createServer((_req, res) => { res.end('<!doctype html><html lang="en"><head><title>Files navigation fixture</title></head><body><main id="root"></main></body></html>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addStyleTag({ content: (await readFile(resolve(project, "src/styles.css"), "utf8")).replace(/^@import .*;$/gm, "") });
  await page.addStyleTag({ content: await readFile(resolve(project, "src/polish.css"), "utf8") });
  for (const output of compiled.outputFiles.filter(file => file.path.endsWith(".css"))) await page.addStyleTag({ content: output.text });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith(".js")).text });
  const local = page.locator('[data-file-side="local"]');
  const remote = page.locator('[data-file-side="remote"]');
  const path = side => page.getByLabel(`${side} directory path`, { exact: true });
  const ready = pane => expect(pane.locator(".file-list")).toHaveAttribute("aria-busy", "false");
  const visit = async (side, value) => { await path(side).fill(value); await path(side).press("Enter"); await ready(side === "local" ? local : remote); await expect(path(side)).toHaveValue(value); };
  await expect(path("remote")).toHaveValue("/srv/alpha");
  await expect(path("local")).toHaveValue("C:/local");
  await expect(remote.locator(".file-environment")).toHaveText("Production");
  await visit("remote","/srv/alpha/test-delete");
  const filter = remote.getByLabel("Search remote files", {exact:true});
  const deleteSelected = remote.getByRole("button", {name:"Delete selection",exact:true});
  const deleteDialog = page.getByRole("dialog", {name:"Delete selected items?",exact:true});
  await remote.getByLabel("Select changed.txt", {exact:true}).check();
  await remote.getByLabel("Select shared.txt", {exact:true}).check();
  await filter.fill("shared");
  await expect(remote.locator(".file-actionbar")).toContainText("1 selected");
  await deleteSelected.click();
  await expect(deleteDialog).toContainText("shared.txt");
  await expect(deleteDialog).toContainText("Alpha");
  await expect(deleteDialog).toContainText("/srv/alpha/test-delete");
  await deleteDialog.getByRole("button", {name:"Cancel"}).click();
  await filter.fill("no such file");
  await expect(deleteSelected).toBeDisabled();
  await remote.getByRole("button",{name:"Clear filter",exact:true}).click();
  await page.evaluate(()=>fixture.select("beta-1"));
  await expect(path("remote")).toHaveValue("/srv/beta");
  await page.evaluate(()=>fixture.select("alpha-1"));
  await expect(path("remote")).toHaveValue("/srv/alpha/test-delete");
  await expect(filter).toHaveValue("");
  await remote.getByLabel("Select shared.txt", {exact:true}).check();
  await remote.getByLabel("Select changed.txt", {exact:true}).check();
  await page.evaluate(()=>{fixture.denyDelete="/srv/alpha/test-delete/changed.txt"});
  await deleteSelected.click();
  await deleteDialog.getByRole("button",{name:"Delete",exact:true}).click();
  await expect(deleteDialog.getByRole("alert")).toContainText("changed.txt");
  await expect(remote.getByLabel("Select shared.txt",{exact:true})).toHaveCount(0);
  await page.evaluate(()=>{fixture.denyDelete=null});
  await deleteDialog.getByRole("button",{name:"Delete",exact:true}).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(remote.getByLabel("Select changed.txt",{exact:true})).toHaveCount(0);
  assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(c=>c.action==="file_delete").map(c=>[c.payload.sessionId,c.payload.path.split("/").pop()])), [["alpha-1","shared.txt"],["alpha-1","changed.txt"],["alpha-1","changed.txt"]]);
  await visit("remote","/srv/alpha");
  // Start navigation coverage with neither tab holding an earlier local listing.
  await page.evaluate(() => fixture.remount());
  await expect(path("remote")).toHaveValue("/srv/alpha");
  await remote.getByRole("button", { name: "Add remote folder bookmark", exact: true }).click();
  await visit("remote", "/srv/alpha/docs");
  await remote.getByRole("button", { name: "Back in remote folders", exact: true }).click();
  await expect(path("remote")).toHaveValue("/srv/alpha");
  await remote.getByRole("button", { name: "Forward in remote folders", exact: true }).click();
  await expect(path("remote")).toHaveValue("/srv/alpha/docs");
  await remote.getByRole("button", { name: "Locations", exact: true }).click();
  const locations = page.getByRole("dialog", { name: "Remote folder locations", exact: true });
  await expect(locations).toContainText("/srv/alpha");
  await locations.getByRole("button", { name: "Remove bookmark /srv/alpha", exact: true }).click();
  await expect(locations.getByRole("button", { name: "Remove bookmark /srv/alpha", exact: true })).toHaveCount(0);
  await locations.getByRole("button", { name: "/srv/alpha", exact: true }).click();
  await expect(path("remote")).toHaveValue("/srv/alpha");
  await visit("remote", "/srv/alpha/docs");
  await visit("local", "C:/local/docs");
  await local.getByRole("button", { name: "Add local folder bookmark", exact: true }).click();
  await page.evaluate(() => fixture.select("beta-1"));
  await expect(path("remote")).toHaveValue("/srv/beta");
  await expect(remote.locator(".file-environment")).toHaveText("Lab");
  await expect(path("local")).toHaveValue("C:/local/docs");
  await page.evaluate(() => fixture.select("alpha-1"));
  await expect(path("remote")).toHaveValue("/srv/alpha/docs");
  await page.evaluate(() => fixture.remount());
  await expect(path("remote")).toHaveValue("/srv/alpha/docs");
  await expect(path("local")).toHaveValue("C:/local/docs");
  await page.evaluate(() => { fixture.deferPath = "/srv/alpha/slow"; });
  await path("remote").fill("/srv/alpha/slow");
  await path("remote").press("Enter");
  await expect(remote.locator(".file-loading")).toBeVisible();
  await expect(remote.getByRole("button", { name: "shared.txt", exact: true })).toBeVisible();
  await page.evaluate(() => fixture.select("beta-1"));
  await expect(path("remote")).toHaveValue("/srv/beta");
  await page.evaluate(() => fixture.release());
  await expect(path("remote")).toHaveValue("/srv/beta");
  await page.evaluate(() => { fixture.failPath = "/srv/beta/denied"; });
  await visit("remote", "/srv/beta/denied");
  await expect(remote.getByRole("alert")).toContainText("Fixture folder access denied");
  await expect(remote.getByRole("button", { name: "shared.txt", exact: true })).toBeVisible();
  await page.evaluate(() => { fixture.failPath = null; });
  await remote.getByRole("button", { name: "Retry", exact: true }).click();
  await ready(remote);
  await expect(remote.getByRole("alert")).toHaveCount(0);
  await remote.getByRole("button", { name: "remote home folder", exact: true }).click();
  await expect(path("remote")).toHaveValue("/srv/beta");
  await page.getByRole("button", { name: "Compare folders", exact: true }).click();
  await expect(local.locator(".file-comparison-label")).toContainText(["Size differs", "Only local"]);
  await expect(remote.locator(".file-comparison-label")).toContainText(["Size differs", "Only remote"]);
  await expect(page.getByText(/Matching metadata does not verify file contents/)).toBeVisible();
  await page.screenshot({ path: resolve(project, "../../work/files-metadata-comparison.png"), fullPage: true });
  await local.getByLabel("Search local files", { exact: true }).fill("absent");
  await expect(local.getByText("No files match “absent”")).toBeVisible();
  await local.getByRole("button", { name: "Clear filter", exact: true }).click();
  await expect(local.getByLabel("Search local files", { exact: true })).toHaveValue("");
  await visit("local", "C:/local/empty");
  await expect(local.getByText("This folder is empty", { exact: true })).toBeVisible();
  await expect(local.getByRole("button", { name: "New folder", exact: true })).toBeVisible();
  const beforeRestore = await page.evaluate(() => fixture.calls.filter(call => call.action === "file_list" && call.payload.side === "remote").length);
  await page.evaluate(() => fixture.restoreDisconnected());
  await expect(remote.getByText("Choose a remote server", { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.action === "file_list" && call.payload.side === "remote").length), beforeRestore);
  await page.evaluate(() => fixture.reconnect());
  await expect(path("remote")).toHaveValue("/srv/alpha/docs");
  await page.evaluate(() => fixture.changeHost("alpha", { hostname: "replacement.example.invalid" }));
  await expect(page.getByRole("button", { name: "Reconnect server", exact: true })).toBeVisible();
  await page.evaluate(() => fixture.reconnect());
  await expect(path("remote")).toHaveValue("/srv/replacement");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("vexssh.files.navigation.v1")));
  assert(saved.scopes.every(scope => !Object.hasOwn(scope, "password") && !Object.hasOwn(scope, "passphrase")));
  assert.equal(saved.scopes.find(scope => scope.key === "host:alpha").lastPath, "/srv/replacement");
  const environmentContrast = [];
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const colors = await page.evaluate(() => ["production", "staging", "development", "lab"].map(environment => {
      const badge = document.createElement("span");
      badge.className = `environment-badge env-${environment}`;
      badge.textContent = environment;
      document.body.append(badge);
      const style = getComputedStyle(badge);
      const result = { environment, foreground: style.color, background: style.backgroundColor };
      badge.remove();
      return result;
    }));
    const luminance = color => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        const component = value / 255;
        return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    for (const entry of colors) {
      const foreground = luminance(entry.foreground), background = luminance(entry.background);
      const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      assert(ratio >= 4.5, `${theme} ${entry.environment} badge contrast ${ratio.toFixed(2)}:1`);
      environmentContrast.push({ theme, ...entry, ratio: Number(ratio.toFixed(2)) });
    }
    await page.setViewportSize({ width: 760, height: 560 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: resolve(project, `../../work/files-navigation-${theme}.png`), fullPage: true });
  }
  await local.getByRole("button", { name: "Locations", exact: true }).click();
  const localLocations = page.getByRole("dialog", { name: "Local folder locations", exact: true });
  await expect(localLocations.getByRole("button", { name: "Remove bookmark C:/local/docs", exact: true })).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
  await expect(localLocations).toHaveCSS("opacity", "1");
  await page.screenshot({ path: resolve(project, "../../work/files-bookmarks.png") });
  await localLocations.getByRole("button", { name: "C:/local/docs", exact: true }).first().click();
  await expect(path("local")).toHaveValue("C:/local/docs");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", historyBookmarksAndRecents: true, hostScopedRestoration: true, disconnectedRestoreNoRemoteIO: true, replacementSessionPathRestore: true, changedRouteInvalidatesPaths: true, retainedListingDuringLoadingAndError: true, staleResponseIgnored: true, retryAndEmptyStates: true, metadataComparison: true, darkLightNarrow: true, environmentContrast, unexpectedErrors: errors }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
