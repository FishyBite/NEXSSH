import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const project = fileURLToPath(new URL("../", import.meta.url));
const built = await build({
  stdin: {
    resolveDir: project,
    loader: "tsx",
    contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {TerminalWorkspace} from './src/TerminalWorkspace';
    import {numberSessionTabs} from './src/terminalCommands';
    import {emptyConfig} from './src/types';
    import '@xterm/xterm/css/xterm.css';
    const host={id:'openshift',name:'OpenShift',username:'core',hostname:'server.invalid',workspaceId:'lab',port:22};
    const config={...emptyConfig,hosts:[host],snippets:[
      {id:'p',name:'Pods',command:'oc get pods',scope:'host',hostId:host.id,favorite:true},
      {id:'ns',name:'Namespace',command:'oc get pods -n {{namespace}}',scope:'workspace',workspaceId:'lab'},
      {id:'m',name:'Two lines',command:'pwd\\nid',scope:'global'},
      {id:'wrong',name:'Wrong',command:'oc get inaccessible',scope:'host',hostId:'wrong'},
      {id:'other',name:'Other',command:'oc get elsewhere',scope:'workspace',workspaceId:'foreign'}]};
    const initial=numberSessionTabs(['a','b'].map(id=>({id,hostId:host.id,name:host.name,status:'connected',latencyMs:1})),config.hosts);
    const fixture=window.fixture={writes:[],notices:[],listeners:new Set()};
    fixture.output=(id,bytes)=>fixture.listeners.forEach(fn=>fn({sessionId:id,data:btoa(bytes)}));
    function Harness(){
      const [sessions,setSessions]=useState(initial),[active,setActive]=useState('a'),
      [action,setAction]=useState(),[visible,setVisible]=useState(true),[mount,setMount]=useState(0);
      fixture.mountWrite=(id, options={})=>{
        setMount(n=>n+1); setActive(options.active || id); setVisible(!options.hidden);
        if(!options.replay) fixture.lastWrite={kind:'write',sessionId:id,id:Date.now(),data:'check'};
        setAction(fixture.lastWrite);
      };
      fixture.act=(id,path)=>{setActive(id);setVisible(true);setAction({kind:'insertPath',sessionId:id,id:Date.now(),data:path});};
      fixture.useFolder=(id,path)=>{setActive(id);setVisible(true);setAction({kind:'useFolder',sessionId:id,id:Date.now(),data:path});};
      fixture.drawerFolder=(id,path)=>{setAction({kind:'useFolder',sessionId:id,id:Date.now(),data:path,drawerSignal:new AbortController().signal});};
      fixture.sendInactive=(id,path)=>setAction({kind:'insertPath',sessionId:id,id:Date.now(),data:path});
      return <TerminalWorkspace key={mount} sessions={sessions} active={active} setActive={setActive} config={config}
        visible={visible} action={action} onTerminalActionConsumed={a=>setAction(v=>v===a?undefined:v)}
        notify={text=>fixture.notices.push(text)} rename={(id,name)=>setSessions(items=>items.map(s=>s.id===id?{...s,name}:s))}/>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);
  `,
  },
  write: false,
  bundle: true,
  outdir: "out",
  jsx: "automatic",
  format: "iife",
  plugins: [
    {
      name: "fake-transport",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/api$/ }, () => ({
          path: "native",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `
      export const desktop=true;
      export async function subscribe(name,fn){
        if(name==='terminal-data')window.fixture.listeners.add(fn);
        return ()=>window.fixture.listeners.delete(fn);
      }
      export async function request(action,payload) {
        if(action==='ssh_write')window.fixture.writes.push(payload);
        if(action==='ssh_check_path_target' && window.fixture.holdCheck)
          await new Promise(resolve=>{window.fixture.finishCheck=resolve;});
        return {};
      }`,
        }));
      },
    },
  ],
});
const server = createServer((_req, res) =>
  res.end('<!DOCTYPE html><html><body><div id="root"></div></body></html>'),
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 750 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  const css = await readFile(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  await page.addStyleTag({ content: css.replace(/^@import .*;$/gm, "") });
  for (const file of built.outputFiles.filter((f) => f.path.endsWith(".css")))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: built.outputFiles.find((f) => f.path.endsWith(".js")).text,
  });
  const second = page.getByRole("tab", { name: "OpenShift · 2", exact: true });
  await expect(second).toHaveAttribute("title", /core@server\.invalid/);
  await second.dblclick();
  await page.getByRole("textbox", { name: "Terminal name" }).fill("Deploy");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Deploy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Command", exact: true }).click();
  const command = page.getByRole("combobox", { name: "Command", exact: true });
  await command.fill("oc get");
  await expect(page.getByRole("option")).toHaveCount(2);
  await command.press("Tab");
  await expect(command).toHaveValue("oc get pods");
  const writes = () => page.evaluate(() => window.fixture.writes);
  assert.deepEqual(await writes(), []);
  await command.press("Enter");
  await expect
    .poll(writes)
    .toEqual([{ sessionId: "b", data: "oc get pods\r" }]);
  await command.fill("Namespace");
  await command.press("Tab");
  await command.press("Enter");
  await expect(
    page.getByText("Fill in the snippet variables before sending."),
  ).toBeVisible();
  assert.equal((await writes()).length, 1);
  await command.fill("Two lines");
  await command.press("Tab");
  await expect(command).toHaveValue("pwd\nid");
  await command.press("Enter");
  await expect
    .poll(async () => (await writes()).at(-1)?.data)
    .toBe("pwd\nid\r");
  await page.evaluate(() =>
    window.fixture.act("a", "/srv/Alice's folder/test; 1"),
  );
  const pathWrite = {
    sessionId: "a",
    data: "'/srv/Alice'\\''s folder/test; 1'",
  };
  await expect.poll(async () => (await writes()).at(-1)).toEqual(pathWrite);
  await expect(
    page.locator('.terminal-pane[data-session-id="a"] .xterm-helper-textarea'),
  ).toBeFocused();
  await page.keyboard.type("x");
  await expect
    .poll(async () => (await writes()).at(-1))
    .toEqual({ sessionId: "a", data: "x" });
  await page.evaluate(() => window.fixture.sendInactive("b", "/srv/skip"));
  await page.getByRole("tab", { name: "Deploy", exact: true }).click();
  await page.evaluate(() => window.fixture.act("b", "/srv/bad\nname"));
  await expect
    .poll(() => page.evaluate(() => window.fixture.notices.at(-1)))
    .toContain("control characters");
  assert.equal((await writes()).length, 4);
  const bInput = page.locator('.terminal-pane[data-session-id="b"] .xterm-helper-textarea');
  const review = page.getByRole("dialog",{name:"Use folder in terminal"});
  await bInput.focus();
  await page.keyboard.type("draft");
  const beforeReview = await writes();
  await page.evaluate(() => window.fixture.useFolder("b","/Team's files"));
  await expect(review).toBeVisible();
  await review.getByRole("button",{name:"Keep current input"}).click();
  await expect(bInput).toBeFocused();
  assert.deepEqual(await writes(), beforeReview);
  await page.evaluate(() => window.fixture.useFolder("b","/Team's files"));
  await review.getByRole("button",{name:"Insert at cursor"}).click();
  await expect(bInput).toBeFocused();
  await expect.poll(async () => (await writes()).at(-1)).toEqual({sessionId:"b",data:"cd -- '/Team'\\''s files'"});
  await page.keyboard.type("!");
  await expect.poll(async () => (await writes()).at(-1)).toEqual({sessionId:"b",data:"!"});
  const beforeRace = await writes();
  await page.evaluate(async () => {
    window.fixture.output("b","\x1b]133;B\x07");
    await new Promise(resolve=>setTimeout(resolve,60));
    window.fixture.holdCheck=true;
    window.fixture.drawerFolder("b","/safe");
  });
  await expect.poll(()=>page.evaluate(()=>typeof window.fixture.finishCheck)).toBe("function");
  await expect(review).toHaveCount(0);
  await expect(bInput).toBeFocused();
  await page.keyboard.type("x");
  await page.evaluate(()=>window.fixture.finishCheck());
  await expect.poll(writes).toEqual([...beforeRace,{sessionId:"b",data:"x"}]);
  await expect.poll(()=>page.evaluate(()=>window.fixture.notices.at(-1))).toContain("prompt changed");
  const priorWrites = await writes();
  const deliberateWrite = { sessionId: "b", data: "check" };
  await page.evaluate(()=>window.fixture.mountWrite("b"));
  await expect.poll(writes).toEqual([...priorWrites,deliberateWrite]);
  for (const options of [{ replay:true }, { active:"a" }, { hidden:true }]) {
    await page.evaluate(async options=>{
      window.fixture.mountWrite("b",options);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    },options);
    assert.deepEqual(await writes(),[...priorWrites,deliberateWrite]);
  }
  await page.evaluate(()=>window.fixture.mountWrite("b"));
  await expect.poll(writes).toEqual([...priorWrites,deliberateWrite,deliberateWrite]);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: tab workflows, quoted path and immediate typing, retained PTY input on cancel, explicit folder insertion, clean prompt verification race.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
