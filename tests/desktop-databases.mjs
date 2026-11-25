import assert from "node:assert/strict";

export async function exerciseDatabases({ page, expect, nav, paletteAction }) {
  const sshSessions = await page.evaluate(() => [...window.fixture.sessions.keys()]);
  assert(sshSessions.length);
  await page.evaluate(() => {
    const ipc = window.__TAURI_INTERNALS__;
    const invoke = ipc.invoke.bind(ipc);
    const state = window.fixture;
    state.dbCalls = [];
    let serial = 0;
    ipc.invoke = async (cmd, args = {}) => {
      const { action, payload } = args;
      if (cmd !== "request" || !action.startsWith("db_")) return invoke(cmd, args);
      state.dbCalls.push({ action, id: payload.id, route: payload.sshSessionId, query:payload.query, token:payload.requestId, readOnly:payload.readOnly,
        usesVault:payload.useSavedPassword===true, saves:payload.rememberPassword===true, empty:!payload.password });
      if (action === "db_prepare_connect") return {id:crypto.randomUUID()};
      if (action === "db_connect") {
        if (state.missingPassword && payload.useSavedPassword) throw new Error("A password is required for this saved database connection.");
        return { id: "db-" + ++serial };
      }
      if (action === "db_objects") return [{ schema: "main", name: "accounts", kind: "table" }];
      if (action === "db_table_page") return {columns:["value"], metadata:[{name:"value",type:"TEXT",primaryKey:true,editable:true}],
        rows:[[payload.id + " " + payload.name]], hasMore:false, truncated:false, editableRows:[true]};
      if (action === "db_disconnect") return null;
      if (action === "db_query" && payload.query === "SELECT 'cancel'") {
        await new Promise((_,reject)=> { state.cancelDbQuery = { id:payload.id, token:payload.requestId, stop:()=>reject("Query cancelled") }; });
      }
      if (action === "db_cancel") {
        const current = state.cancelDbQuery;
        const matches = current?.id === payload.id && current?.token === payload.requestId;
        if (matches) current.stop();
        return {cancelled:matches};
      }
      if (action === "db_query" && payload.query === "SELECT 'hold'") {
        await new Promise(resolve => { state.releaseDbQuery = resolve; });
      }
      return { columns: ["value"], rows: [[payload.id + " " + (payload.query || payload.name)]], truncated: false };
    };
  });
  await paletteAction("Open databases");
  async function openForm() {
    await page.getByRole("button", { name: "New connection", exact: true }).first().click();
    return page.getByRole("dialog");
  }
  let form = await openForm();
  assert.equal(await form.locator("optgroup").count(), 11);
  await form.getByLabel("Connection name").fill("Reporting A");
  await form.getByLabel("Database type").selectOption("postgresql");
  await form.getByLabel("Environment").selectOption("production");
  await expect(form.getByLabel("Access")).toHaveValue("read");
  await form.getByLabel("Network route").selectOption("ssh");
  await expect(form.getByLabel(/^SSH session/)).toHaveValue(sshSessions[0]);
  await form.getByLabel("Password", {exact:true}).fill("fixture-connection-secret");
  await form.getByLabel("Remember password in secure storage").check();
  await form.getByRole("button", { name: "Save & connect" }).click();
  const paneA = page.getByRole("region", { name: "Database session Reporting A" });
  await paneA.getByRole("textbox", { name: "SQL query" }).fill("SELECT 'hold'");
  await paneA.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.fixture.releaseDbQuery)).toBe(true);
  form = await openForm();
  await form.getByLabel("Connection name").fill("Local B");
  await form.getByLabel("Database type").selectOption("sqlite");
  await form.getByLabel("Database file").fill("C:\\Fixture\\books.db");
  await expect(form.getByLabel("Password")).toHaveCount(0);
  await form.getByRole("button", { name: "Save & connect" }).click();
  const paneB = page.getByRole("region", { name: "Database session Local B" });
  await expect(paneB).toBeVisible();
  await page.evaluate(() => window.fixture.releaseDbQuery());
  await page.getByRole("button", { name: /accounts table/ }).click();
  await expect(paneB.getByRole("cell", { name: "db-2 accounts" })).toBeVisible();
  await expect(paneB.getByText(/db-1 /)).toHaveCount(0);
  await page.getByRole("button", { name: "Switch to Reporting A" }).click();
  await expect(paneA.getByRole("cell", { name: "db-1 SELECT 'hold'" })).toBeVisible();
  await nav("Terminal").click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))).toBe(true);
  assert.deepEqual(await page.evaluate(() => [...window.fixture.sessions.keys()]), sshSessions);
  await paletteAction("Open databases");
  await expect(paneA.getByRole("textbox", { name: "SQL query" })).toHaveValue("SELECT 'hold'");
  await paneA.getByRole("button",{name:"New query tab"}).click();
  const editor = paneA.getByRole("textbox", { name: "SQL query" });
  await editor.fill("SELECT 'never'; SELECT 'chosen'");
  await editor.evaluate(e=>e.setSelectionRange(16,e.value.length));
  await editor.press("Control+Enter");
  await expect(paneA.getByRole("cell",{name:"db-1 SELECT 'chosen'"})).toBeVisible();
  await paneA.getByRole("button",{name:"Save named query"}).click();
  await page.getByRole("dialog").getByLabel("Query name").fill("Audit snapshot");
  await page.getByRole("dialog").getByRole("button",{name:"Save query", exact:true}).click();
  await paneA.getByRole("button",{name:"Close Audit snapshot"}).click();
  await paneA.getByRole("button",{name:"Saved queries",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Audit snapshot",exact:true}).click();
  await expect(editor).toHaveValue("SELECT 'never'; SELECT 'chosen'");
  await editor.fill("SELECT 'cancel'");
  await editor.press("Control+Enter");
  await paneA.getByRole("button",{name:"Cancel query",exact:true}).click();
  await expect(paneA.getByRole("alert")).toContainText("cancelled");
  await editor.fill("SELECT 'keep draft'");
  const countQueries=()=>page.evaluate(()=>window.fixture.dbCalls.filter(x=>x.action==="db_query").length);
  const before=await countQueries();
  await paneA.getByRole("button",{name:"Reconnect database"}).click();
  await expect.poll(()=>page.evaluate(()=>window.fixture.dbCalls.filter(c=>c.action==="db_connect").length)).toBe(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(editor).toHaveValue("SELECT 'keep draft'");
  assert.equal(await countQueries(),before);
  await paneA.getByRole("button", { name: "Disconnect database" }).click();
  const discard = page.getByRole("dialog", { name: "Disconnect database?" });
  await expect(discard).toContainText("Reporting A");
  await discard.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveValue("SELECT 'keep draft'");
  await paneA.getByRole("button", { name: "Disconnect database" }).click();
  await discard.getByRole("button", { name: "Discard and disconnect", exact: true }).click();
  await expect(paneB).toBeVisible();
  await paneB.getByRole("button", { name: "Disconnect database" }).click();
  await expect(page.getByRole("button", { name: "Connect to Reporting A", exact: true })).toBeVisible();
  await page.evaluate(()=>{window.fixture.missingPassword=true;});
  await page.getByRole("button", { name: "Connect to Reporting A" }).click();
  await expect(page.getByRole("dialog").getByLabel("Password",{exact:true})).toHaveValue("");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(()=>{window.fixture.missingPassword=false;});
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-connection-secret")), false);
  assert.deepEqual(await page.evaluate(() => window.fixture.dbCalls.filter(c => c.action === "db_connect").map(c => [c.route || null,c.readOnly,c.usesVault,c.saves,c.empty])),
    [[sshSessions[0],true,false,true,false],[null,false,false,false,true],[sshSessions[0],true,true,false,true],[sshSessions[0],true,true,false,true]]);
  await nav("Terminal").click();
  const mode = name => page.getByRole("group",{name:"Session view"}).getByRole("button",{name,exact:true});
  await mode("Database").click();
  await page.getByRole("button",{name:"Connect to Reporting A"}).click();
  await expect(paneA).toBeVisible();
  await editor.fill("SELECT 'after reconnect'");
  await mode("SFTP").click();
  await mode("Database").click();
  await expect(editor).toHaveValue("SELECT 'after reconnect'");
  const count=await countQueries();
  await page.evaluate(id => {
    window.fixture.sessions.delete(id);
    window.fixture.emit("terminal-status",{sessionId:id,status:"disconnected"});
  }, sshSessions[0]);
  await expect(paneA.getByRole("button",{name:"Run",exact:true})).toBeDisabled();
  await paneA.getByRole("button",{name:"Reconnect",exact:true}).click();
  await expect(paneA).toBeVisible();
  await expect(editor).toHaveValue("SELECT 'after reconnect'");
  await expect(paneA.getByRole("button",{name:"Run",exact:true})).toBeEnabled();
  assert.equal(await countQueries(),count);
  const route=await page.evaluate(()=>window.fixture.dbCalls.filter(c=>c.action==="db_connect").at(-1).route);
  assert.notEqual(route,sshSessions[0]);
  assert(await page.evaluate(id=>window.fixture.sessions.has(id),route));
  await mode("Terminal").click();
  // The two SSH tabs share one host preference but each keeps its active DB.
  await page.getByRole("tab", { selected: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate connection", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  const second = await page.getByRole("tab", { selected: true }).evaluate(button => button.closest(".session-tab").dataset.sessionId);
  assert.notEqual(second,route);
  await mode("Database").click();
  await page.getByRole("button", { name: "Connect to Local B" }).click();
  await expect(paneB).toBeVisible();
  await page.locator(`.session-tab[data-session-id="${route}"] [role="tab"]`).click();
  await expect(editor).toHaveValue("SELECT 'after reconnect'");
  await page.locator(`.session-tab[data-session-id="${second}"] [role="tab"]`).click();
  await expect(paneB).toBeVisible();
  await paneB.getByRole("button", { name: "Disconnect database" }).click();
  await mode("Terminal").click();
  await page.locator(`.session-tab[data-session-id="${second}"] .session-tab-close`).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await paletteAction("Open databases");
  await page.getByRole("button", {name:"Create workspace", exact:true}).click();
  const createWorkspace = page.getByRole("dialog", {name:"Create workspace"});
  await createWorkspace.getByLabel("Workspace name").fill("Other workspace");
  await createWorkspace.getByRole("button", {name:"Create workspace"}).click();
  const switching = page.getByRole("dialog", {name:"Switch workspace?"});
  await expect(switching).toContainText("Unsaved query edits");
  await switching.getByRole("button", {name:"Cancel"}).click();
  await page.getByRole("button", {name:"Switch to Reporting A"}).click();
  await expect(editor).toHaveValue("SELECT 'after reconnect'");
  await page.evaluate(() => window.fixture.emit("tauri://close-requested", null));
  const closing = page.getByRole("dialog", {name:"Close NEXSSH?"});
  await expect(closing).toContainText("Unsaved query edits");
  await closing.getByRole("button", {name:"Cancel"}).click();
  await page.getByLabel("Workspace", {exact:true}).selectOption({label:"Other workspace"});
  await switching.getByRole("button", {name:"Discard and switch"}).click();
  await expect(page.getByText("No saved connections", {exact:true})).toBeVisible();
}
