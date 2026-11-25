import assert from "node:assert/strict";

// A remote file becomes a draft in the SSH tab's chosen DB. Opening a file
// or switching back to its terminal must never submit SQL.
export async function exerciseSftpSql({page, expect, nav}) {
  const sql = "SELECT 'session-bound draft' AS message";
  const sessionId = await page.evaluate(() => [...window.fixture.sessions.keys()][0]);
  await page.evaluate((text) => {
    const ipc = window.__TAURI_INTERNALS__, invoke = ipc.invoke.bind(ipc);
    const state = window.fixture;
    state.fileToSql = {queries:[],connections:[],reads:[]};
    ipc.invoke = async (cmd, args = {}) => {
      if (cmd !== "request") return invoke(cmd,args);
      const {action,payload} = args;
      if (action === "file_list" && payload.side === "remote") {
        const dir = await invoke(cmd,args);
        return {...dir,entries:[...dir.entries,{name:"check.sql",path:dir.path+"/check.sql",isDir:false,isSymlink:false,size:40,modified:1794450000,permissions:"644"}]};
      }
      if (action === "file_read" && payload.path.endsWith("/check.sql")) {
        state.fileToSql.reads.push(payload.sessionId);
        return {content:text,revision:"fixture-sql-1"};
      }
      if (action === "db_prepare_connect") return {id:"fixture-ssh-db"};
      if (action === "db_connect") { state.fileToSql.connections.push(payload.sshSessionId); return {id:"fixture-ssh-db"}; }
      if (action === "db_objects") return [];
      if (action === "db_query") { state.fileToSql.queries.push([payload.id,payload.query]); return {columns:["message"],rows:[["OK"]],truncated:false}; }
      return invoke(cmd,args);
    };
  },sql);
  await nav("Files").click();
  const remote = page.locator('[data-file-side="remote"]');
  await remote.getByRole("button",{name:"Refresh remote directory"}).click();
  await remote.locator('[data-file-path$="/check.sql"]').click({button:"right"});
  await page.getByRole("menuitem",{name:"Open in SQL Editor"}).click();
  const view = page.getByRole("group",{name:"Session view"});
  await expect(view.getByRole("button",{name:"Database",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(page.getByText("Choose a SQL connection for", {exact:false})).toBeVisible();
  await page.getByRole("button",{name:"New connection",exact:true}).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Connection name").fill("SSH database fixture");
  await expect(form.getByLabel("Network route")).toHaveValue("ssh");
  await form.getByRole("button",{name:"Save & connect"}).click();
  const scope = page.getByRole("region",{name:"Database session SSH database fixture"});
  const editor = scope.getByRole("textbox",{name:"SQL query"});
  await expect(editor).toHaveValue(sql);
  await expect(scope.getByText("check.sql",{exact:true}).first()).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.fixture.fileToSql),{connections:[sessionId],queries:[],reads:[sessionId]});
  await view.getByRole("button",{name:"Terminal",exact:true}).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))).toBe(true);
  await view.getByRole("button",{name:"Database",exact:true}).click();
  await expect(editor).toHaveValue(sql);
  await scope.getByRole("button",{name:"Run",exact:true}).click();
  await expect(scope.getByRole("cell",{name:"OK",exact:true})).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.fixture.fileToSql.queries),[["fixture-ssh-db",sql]]);
  await view.getByRole("button",{name:"Terminal",exact:true}).click();
}
