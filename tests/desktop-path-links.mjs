import { clickOutputPath } from './click-output-path.mjs';
import assert from "node:assert/strict";
import { exercisePreviewEdit } from "./desktop-preview-edit.mjs";

export async function exercisePathLinks({page, expect, fixture}) {
  const mode = name => page.getByRole("group", {name:"Session view"}).getByRole("button", {name,exact:true});
  const sessionIds = () => page.evaluate(() => [...window.fixture.sessions.keys()]);
  const [firstId] = await sessionIds();
  await page.getByRole("button", {name:"Remote folder actions",exact:true}).click();
  await page.getByRole("menuitem", {name:"Open terminal here",exact:true}).click();
  await expect(mode("Terminal")).toHaveAttribute("aria-pressed","true");
  const [,secondId] = await sessionIds();
  const tab = index => page.getByRole("tab",{name:fixture.state_load.hosts[0].name+" · "+index,exact:true});
  const input = id => page.locator('.terminal-pane[data-session-id="'+id+'"] .xterm-helper-textarea');
  const requests = () => page.evaluate(() => window.fixture.pathCalls);
  const writes = () => page.evaluate(() => window.fixture.calls.filter(c=>c.args?.action==="ssh_write").map(c=>c.args.payload));
  const dialog = page.getByRole("dialog",{name:"File preview",exact:true});

  await page.evaluate(() => {
    const state = window.fixture;
    state.pathCalls = [];
    const transport = window.__TAURI_INTERNALS__;
    const invoke = transport.invoke.bind(transport);
    transport.invoke = async (cmd, args={}) => {
      if (cmd !== "request") return invoke(cmd,args);
      const p = args.payload;
      if (args.action === "file_list" && p.path === "/srv/team logs") return {path:p.path,entries:[]};
      if (args.action !== "file_preview_path") return invoke(cmd,args);
      state.pathCalls.push(p);
      if (p.path === "/srv/team logs") return {kind:"directory",path:p.path};
      if (p.path === "/missing.cfg") throw new Error("No such file");
      if (p.path === "/delayed.txt") await new Promise(resolve=>state.finishPreview=resolve);
      return {kind:"file",path:p.path,content:Array.from({length:701},(_,i)=>"config entry "+(i+1)).join("\n"),revision:"fixture-preview"};
    };
  });
  const emit = (sessionId, text) => page.evaluate(({sessionId,text}) => {
    const data = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    window.fixture.emit("terminal-data",{sessionId,data});
  }, {sessionId,text});
  const clickOutput = (...args) => clickOutputPath(page, ...args);
  await emit(secondId, '\r\n提示 /etc/nginx/nginx.conf:420\r\n"/srv/team logs"\r\n/missing.cfg\r\n/delayed.txt\r\n');
  await clickOutput(secondId,"nginx.conf",false);
  assert.deepEqual(await requests(),[]);
  await clickOutput(secondId,"nginx.conf",true);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".preview-target-line")).toHaveText("config entry 420");
  await expect(dialog.locator(".preview-target-line")).toBeInViewport();
  await expect(dialog.getByRole("textbox",{name:"File contents"})).toHaveAttribute("aria-readonly","true");
  await expect(dialog.getByText("Line 420 of 701")).toBeVisible();
  await dialog.getByRole("button",{name:"Close dialog"}).click();
  await page.keyboard.type("x");
  await expect.poll(writes).toEqual([{sessionId:secondId,data:"x"}]);
  await expect(input(secondId)).toBeFocused();
  await clickOutput(secondId,"/srv/team",true);
  const drawer = page.getByRole("complementary",{name:/^Remote files for /});
  await expect(drawer.getByRole("textbox",{name:"Remote folder path"})).toHaveValue("/srv/team logs");
  await expect(tab(2)).toHaveAttribute("aria-selected","true");
  await drawer.getByRole("button",{name:"Close remote files panel"}).click();
  await clickOutput(secondId,"/missing.cfg",true);
  await expect(page.getByText(/Could not open \/missing.cfg.*No such file/)).toBeVisible();
  await clickOutput(secondId,"/delayed.txt",true);
  await expect.poll(()=>page.evaluate(()=>typeof window.fixture.finishPreview)).toBe("function");
  await tab(1).click();
  await tab(2).click();
  await page.evaluate(async()=>{window.fixture.finishPreview(); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  await expect(dialog).toHaveCount(0);
  assert.ok((await requests()).every(r=>r.side==="remote" && r.sessionId===secondId));
  assert.deepEqual(await sessionIds(),[firstId,secondId]);
  assert.deepEqual(await writes(),[{sessionId:secondId,data:"x"}]);
  await page.getByRole("button",{name:"Split terminal",exact:true}).click();
  await page.getByRole("menuitemradio",{name:"Split side by side"}).click();
  await expect(tab(2)).toHaveAttribute("aria-selected","true");
  await emit(firstId,"\r\n/split-owner.cfg:17\r\n");
  await clickOutput(firstId,"split-owner",true);
  await expect(dialog.locator(".preview-target-line")).toHaveText("config entry 17");
  assert.deepEqual((await requests()).at(-1), {side:"remote",sessionId:firstId,path:"/split-owner.cfg"});
  await page.keyboard.press("Escape");
  await page.keyboard.type("e");
  await expect(tab(1)).toHaveAttribute("aria-selected","true");
  await expect.poll(writes).toEqual([{sessionId:secondId,data:"x"},{sessionId:firstId,data:"e"}]);
  await expect(input(firstId)).toBeFocused();
  const edit = await exercisePreviewEdit({page, expect, firstId, clickOutput, writes, input});
  return {gestureOnly:true, lineScrolledAndHighlighted:true, readOnly:true, quotedDirectory:true, missingPathError:true,
    staleReadIgnored:true, clickedSplitPaneOwnsRequest:true, sameConnectionAndImmediateTyping:true, edit};
}
