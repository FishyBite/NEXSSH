import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const fixture = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "tsx",
    contents: [
      "import React, { useState } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import { TerminalFileDrawer } from './src/TerminalFileDrawer';",
      "const f = window.fixture = { listeners:new Set(), calls:[], notices:[], labels:[], scale:2, uploaded:new Set() };",
      "const downloadHistory = new Map(); f.choices=[]; f.choose=options=>{f.choices.push(options);return new Promise(resolve=>f.finishChoice=resolve);};",
      "f.invoke = async (action,payload) => { f.calls.push({action,payload});",
      "  if(action==='transfer_start') return {id:'transfer-'+f.calls.length};",
      "  if(action==='transfer_reveal') return true;",
      "  if(action!=='file_list') throw Error('Unexpected action '+action);",
      "  const path = payload.path==='.' ? '/home' : payload.path;",
      "  return {path, entries:['folder','ordinary.txt',...f.uploaded].map((name,i)=>({name, path:path+'/'+name,isDir:i===0,isSymlink:false,size:12}))}; };",
      "function App(){const [id,change]=useState('first'), [transfers,setTransfers]=useState([]); f.switch=change;",
      " f.finishDownload=record=>setTransfers(old=>[record,...old.filter(x=>x.id!==record.id)]);",
      " f.complete=name=>{f.uploaded.add(name);setTransfers(old=>[...old,{id:name,sessionId:id,destination:'/home/'+name,status:'completed',direction:'upload'}]);};",
      " return <main><input aria-label='other field' /><TerminalFileDrawer key={id} session={{id,tabId:id.split(':')[0], name:'Host '+id, status:'connected'}}",
      "  downloadHistory={downloadHistory} onEditFile={entry=>f.labels.push('edit '+entry.path)}",
      "  initialFolder='/home' follow={false} transfers={transfers} notify={(...args)=>f.notices.push(args)}",
      "  onUploaded={()=>f.labels.push('queued')} onUploadAccepted={()=>f.labels.push('accepted')}",
      "  onInsert={()=>{}} onUseFolder={()=>{}} onClose={()=>{}} /></main>;",
      "} createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);",
    ].join("\n"),
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  outdir: "out",
  plugins: [
    {
      name: "isolated-desktop",
      setup(builder) {
        const api =
          "export const desktop = true; export const request = (...args)=>window.fixture.invoke(...args);";
        const windowApi =
          "export const getCurrentWindow=()=>({onDragDropEvent:async fn=>{const f=window.fixture;f.listeners.add(fn);return ()=>f.listeners.delete(fn);},scaleFactor:async()=>{const f=window.fixture;if(f.holdScale){f.holdScale=false;await new Promise(done=>f.releaseScale=done);}return f.scale;}});";
        builder.onResolve({ filter: /^\.\/api$/ }, () => ({
          path: "api",
          namespace: "fake",
        }));
        builder.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({
          path: "window",
          namespace: "fake",
        }));
        builder.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({
          path: "dialog", namespace: "fake",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fake" }, ({ path }) => ({
          contents: path === "api" ? api : path === "dialog" ? "export const open=options=>window.fixture.choose(options)" : windowApi,
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 740 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://127.0.0.1/drawer-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="root"></div>',
    }),
  );
  await page.goto("http://127.0.0.1/drawer-fixture");
  await page.addStyleTag({
    content: fixture.outputFiles.find((f) => f.path.endsWith(".css")).text,
  });
  await page.addStyleTag({
    content:
      ".terminal-file-drawer{height:480px;width:310px} .drawer-entry{display:block;height:32px} .drawer-drop-hint{background:white}",
  });
  await page.addScriptTag({
    content: fixture.outputFiles.find((f) => f.path.endsWith(".js")).text,
  });
  const drawer = page.locator(".terminal-file-drawer");
  const folder = drawer.getByRole("button", {
    name: "Open folder folder",
    exact: true,
  });
  const list = drawer.getByRole("group", { name: "Remote entries" });
  const address = drawer.getByRole("textbox", { name: "Remote folder path" });
  const hint = drawer.locator(".drawer-drop-hint");
  const transfers = () =>
    page.evaluate(() =>
      window.fixture.calls
        .filter((c) => c.action === "transfer_start")
        .map((c) => c.payload),
    );
  const paths = ["C:\\Data Files\\settings.yaml", "C:\\Data Files\\bundle.zip"];
  const emit = (type, position, files = paths) =>
    page.evaluate(
      ({ type, position, paths }) => {
        const f = window.fixture;
        for (const fn of f.listeners)
          fn({
            payload: {
              type,
              position: { x: position.x * f.scale, y: position.y * f.scale },
              paths,
            },
          });
      },
      { type, position, paths: files },
    );
  const point = async (locator, bottom = false) => {
    const box = await locator.boundingBox();
    assert.ok(box);
    return {
      x: box.x + box.width / 2,
      y: box.y + (bottom ? box.height - 4 : box.height / 2),
    };
  };
  const atFrame = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  await expect(folder).toBeVisible();
  const background = await point(list, true),
    nested = await point(folder);
  await emit("enter", background);
  await expect(hint).toHaveText("Upload 2 items to Host first · /home");
  await emit("over", nested);
  await expect(hint).toHaveText("Upload 2 items to Host first · /home/folder");
  await emit("drop", nested);
  await expect.poll(async () => (await transfers()).length).toBe(2);
  let batch = await transfers();
  assert.deepEqual(
    batch.map((x) => [
      x.source,
      x.destination,
      x.sessionId,
      x.direction,
      x.protocol,
    ]),
    [
      [paths[0], "/home/folder/settings.yaml", "first", "upload", "sftp"],
      [paths[1], "/home/folder/bundle.zip", "first", "upload", "sftp"],
    ],
  );
  assert.ok(batch[0].batchId && batch[0].batchId === batch[1].batchId);
  await expect(hint).toHaveCount(0);
  await emit("drop", nested); // duplicate native drop from the same gesture
  await atFrame();
  assert.equal((await transfers()).length, 2);
  await emit("enter", nested);
  await expect(hint).toHaveText("Upload 2 items to Host first · /home/folder");
  await emit("drop", background);
  await atFrame();
  assert.equal(
    (await transfers()).length,
    2,
    "Released onto a folder that was never highlighted",
  );
  await emit("enter", background);
  await expect(hint).toBeVisible();
  await emit("drop", background);
  await expect.poll(async () => (await transfers()).length).toBe(4);
  await address.focus();
  await page.evaluate(() => window.fixture.complete("settings.yaml"));
  await expect(
    drawer.getByRole("button", { name: "Select settings.yaml" }),
  ).toBeVisible();
  await expect(address).toBeFocused();
  const transformations = {
    navigate: async () => {
      await address.fill("/elsewhere");
      await address.press("Enter");
      await expect(folder).toBeVisible();
    },
    replaceSession: async () => {
      await page.evaluate(() => window.fixture.switch("second"));
      await expect(drawer).toHaveAccessibleName("Remote files for Host second");
    },
    moveLayout: async () => {
      await drawer.evaluate((el) => (el.style.marginLeft = "45px"));
    },
    openModal: async () => {
      await page.evaluate(() => {
        const el = document.createElement("div");
        el.setAttribute("role", "dialog");
        document.body.append(el);
      });
    },
  };
  for (const [kind, change] of Object.entries(transformations)) {
    const where = await point(list, true);
    await emit("enter", where);
    await expect(hint).toBeVisible();
    await page.evaluate(() => {
      window.fixture.holdScale = true;
      delete window.fixture.releaseScale;
    });
    await emit("drop", where);
    await expect
      .poll(() => page.evaluate(() => typeof window.fixture.releaseScale))
      .toBe("function");
    await change();
    await page.evaluate(() => window.fixture.releaseScale());
    await atFrame();
    assert.equal(
      (await transfers()).length,
      4,
      kind + " retargeted an old drop",
    );
    if (kind === "openModal")
      await page.evaluate(() =>
        document.querySelector('[role="dialog"]').remove(),
      );
  }
  const where = await point(list, true);
  await emit("enter", where);
  await expect(hint).toBeVisible();
  await page.evaluate(() => window.fixture.switch("third"));
  await expect(drawer).toHaveAccessibleName("Remote files for Host third");
  await emit("drop", where);
  await atFrame();
  assert.equal((await transfers()).length, 4);
  const search = drawer.getByRole("textbox", { name: "Filter remote files" });
  await list.focus();
  await page.keyboard.type("oRd");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("oRd");
  const ordinary = drawer.getByRole("button", { name: "Select ordinary.txt" });
  await expect(folder).toHaveCount(0);
  await search.press("ArrowDown");
  await expect(ordinary).toBeFocused();
  await ordinary.press("Enter");
  assert.ok(await page.evaluate(() => window.fixture.labels.includes("edit /home/ordinary.txt")));
  await ordinary.press("Escape");
  await expect(search).toHaveValue("");
  await list.press("f");
  await search.press("Enter");
  await expect(address).toHaveValue("/home/folder");
  await expect(folder).toBeFocused();
  await expect(search).toHaveValue("");
  await drawer.getByRole("button", {name:"Parent remote folder"}).click();
  await expect(address).toHaveValue("/home");
  await ordinary.click();
  await drawer.getByRole("checkbox", {name:"Include settings.yaml in selection"}).check();
  const download = drawer.getByRole("button", {name:/^Download .*to…$/});
  await expect(download).toHaveAccessibleName("Download 2 to…");
  const choose = async (count) => {
    await download.click();
    await expect.poll(() => page.evaluate(() => window.fixture.choices.length)).toBe(count);
    return page.evaluate(() => window.fixture.choices.at(-1));
  };
  const dest = "C:\\QA folder, with space";
  assert.equal((await choose(1)).defaultPath, undefined);
  await page.evaluate((path) => window.fixture.finishChoice(path), dest);
  await expect.poll(async () => (await transfers()).length).toBe(6);
  const downloads = (await transfers()).slice(4);
  assert.deepEqual(downloads.map((x) => [x.source,x.destination,x.direction,x.protocol,x.sessionId]), [
    ["/home/ordinary.txt", dest + "\\ordinary.txt", "download", "sftp", "third"],
    ["/home/settings.yaml", dest + "\\settings.yaml", "download", "sftp", "third"],
  ]);
  assert.equal(downloads[0].batchId, downloads[1].batchId);
  const reveal = drawer.getByRole("button", {name:"Show in Explorer"});
  await expect(reveal).toHaveCount(0);
  const transfer = await page.evaluate(() => {
    const index = window.fixture.calls.findIndex(c => c.action === "transfer_start" && c.payload.direction === "download");
    return { ...window.fixture.calls[index].payload, id:"transfer-"+(index+1) };
  });
  await page.evaluate(t => window.fixture.finishDownload({...t,status:"conflict"}), transfer);
  await expect(reveal).toHaveCount(0);
  await page.evaluate(t => window.fixture.finishDownload({...t,status:"completed",skippedFiles:1}), transfer);
  await expect(reveal).toHaveCount(0);
  const renamedPath = dest + "\\ordinary (1).txt";
  await page.evaluate(({t,path}) => window.fixture.finishDownload({...t,status:"completed",renamedPaths:{[t.destination]:path}}), {t:transfer,path:renamedPath});
  await expect(reveal).toHaveAttribute("title",renamedPath);
  await reveal.click();
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.at(-1)), {action:"transfer_reveal",payload:{id:transfer.id}});
  assert.equal((await choose(2)).defaultPath, dest);
  await page.evaluate(() => window.fixture.switch("different"));
  await expect(drawer).toHaveAccessibleName("Remote files for Host different");
  await page.evaluate(() => window.fixture.finishChoice("C:\\stale"));
  await expect(reveal).toHaveCount(0);
  await ordinary.click();
  assert.equal((await choose(3)).defaultPath, undefined);
  await page.evaluate(() => window.fixture.finishChoice(null));
  await page.evaluate(() => window.fixture.switch("third:reconnected"));
  await expect(drawer).toHaveAccessibleName("Remote files for Host third:reconnected");
  await ordinary.click();
  assert.equal((await choose(4)).defaultPath, dest);
  await page.evaluate(() => window.fixture.finishChoice(null));
  assert.equal((await transfers()).length, 6);
  await expect(reveal).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS drawer native SFTP upload batch, DPI, directory hint, duplicate and stale drops, completion refresh and retained focus.",
  );
  console.log("PASS drawer type-to-filter, keyboard open, multi-download batch, tab-scoped destination, guarded completion, stale chooser and Explorer action.");
} finally {
  await browser.close();
}
