import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, sep } from "node:path";
import assert from "node:assert/strict";
import { exerciseTabReordering } from "./desktop-tabs-scenario.mjs";
import { exerciseEnhancements } from "./desktop-enhancements.mjs";
import { exerciseFilesDrag } from "./desktop-files-drag.mjs";
import { exerciseTerminalRetry } from "./desktop-terminal-retry.mjs";
import { exerciseTerminalClipboard } from "./desktop-terminal-clipboard.mjs";
import { exerciseRemoteTerminalActions } from "./desktop-remote-terminal.mjs";
import { exerciseSessionNavigation } from "./desktop-session-navigation.mjs";
import { exerciseRemoteDrawer } from "./desktop-remote-drawer.mjs";
import { exerciseDrawerResize } from "./desktop-drawer-resize.mjs";
import { exercisePathLinks } from "./desktop-path-links.mjs";
import { exerciseRelativeLinks } from "./desktop-relative-links.mjs";
import { exerciseShellFiles } from "./desktop-shell-files.mjs";
import { exerciseSessionHistory } from "./desktop-session-history.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/desktop-api.json", import.meta.url),
    "utf8",
  ),
);
if (process.env.VEXSSH_TERMINAL_CLIPBOARD === "1") delete fixture.state_load.settings.copyOnSelect;
if (process.env.VEXSSH_WINDOW_SCROLL === "1") {
  const host = fixture.state_load.hosts[0];
  fixture.state_load.settings.sidebarCollapsed = true;
  for (let n = 1; n <= 30; n++) fixture.state_load.hosts.push({...host, id:"scroll-" + n, name:"Server " + n});
  fixture.transfer_list = ["download","upload","download"].map((direction,n) => ({
    id:"t" + n, sessionId:"fixture-key", direction, protocol:"sftp", source:"/sample/" + "long-file-".repeat(18) + n + ".txt",
    destination:"/sample/", status:"completed", totalBytes:32, transferredBytes:32, speedBytesPerSecond:0, etaSeconds:null, startedAt:n+1,
  }));
}
if (process.env.VEXSSH_HOST_CARDS === "1") {
  const [first, second] = fixture.state_load.hosts;
  Object.assign(first, {name:"OpenShift", hostname:"192.0.2.172", username:"core", environmentLabel:"production",
    icon:"cloud", favorite:true});
  Object.assign(second, {name:"AppViewX", hostname:"192.0.2.74", username:"appviewx", environmentLabel:"staging", icon:"server", favorite:false});
  fixture.state_load.hosts.push(
    {...first,id:"card-rfs",name:"RFS",hostname:"192.0.2.41",username:"ops",authMethod:"password",icon:"server",favorite:false,environmentLabel:"development"},
    {...first,id:"card-keysafe",name:"KeySafe",hostname:"192.0.2.75",username:"ops",icon:"database",favorite:false,environmentLabel:"production"},
    {...first,id:"card-hsm",name:"HSM 10G",hostname:"192.0.2.25",username:"cli",authMethod:"agent",icon:"terminal",favorite:false,environmentLabel:"lab"},
  );
}
if (process.env.VEXSSH_SESSION_TARGETS === "1" || process.env.VEXSSH_MIXED_VIEWS === "1") {
  const [hostA, hostB] = fixture.state_load.hosts;
  Object.assign(hostB, { authMethod: hostA.authMethod, keySource: hostA.keySource, identityFile: hostA.identityFile });
  fixture.state_load.snippets = [hostA, hostB].map(host => ({
    id: "only-" + host.id, name: "Snippet for " + host.name, scope: "host", hostId: host.id,
    command: "echo original", category: "Fixture", favorite: false,
  }));
}
if (process.env.VEXSSH_REMOTE_TERMINAL === "1") {
  fixture.state_load.snippets = [
    {id:"pods", name:"List pods", command:"oc get pods", scope:"host", hostId:"fixture-key", category:"OpenShift", favorite:true},
    {id:"wrong", name:"Wrong server", command:"oc get nodes", scope:"host", hostId:"fixture-password", category:"OpenShift", favorite:false}
  ];
}
if (process.env.VEXSSH_REORDER_TABS === "1") {
  for (let index = 2; index <= 8; index++) {
    fixture.state_load.hosts.push({
      ...fixture.state_load.hosts[0],
      id: `fixture-drag-${index}`,
      name: `Drag host ${index}`,
      hostname: `drag-${index}.example.invalid`,
    });
  }
}
if (process.env.VEXSSH_ENHANCEMENTS === "1") {
  fixture.state_load.groups = [{ id: "fixture-ops", name: "Operations", workspaceId: "fixture-workspace" }];
  fixture.state_load.terminalProfiles = [{ id: "fixture-readable", name: "Readable mono", fontFamily: "Consolas", fontSize: 16, cursorStyle: "bar", copyOnSelect: false, environment: {}, terminalTheme: "dark" }];
  fixture.state_load.settings.restoreWorkspace = true;
}
const dist = resolve(
  process.env.VEXSSH_REPRO_DIST ||
    fileURLToPath(new URL("../dist/", import.meta.url)),
);
const tauri = JSON.parse(
  await readFile(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const path = resolve(
      dist,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (!path.startsWith(dist + sep) && path !== resolve(dist, "index.html"))
      throw new Error("Invalid path");
    let content = await readFile(path);
    if (process.env.VEXSSH_TERMINAL_RETRY === "1" && extname(path) === ".js") {
      const source = content.toString("utf8");
      const marker = '"aria-label":"SSH terminals"';
      if (source.includes(marker)) {
        assert.equal(source.split(marker).length - 1, 1, "Expected one terminal render injection point");
        content = Buffer.from(source.replace(marker, '"aria-label":(()=>{if(window.fixture?.injectTerminalRenderError)throw new Error("Injected terminal render failure");return "SSH terminals"})()'));
      }
    }
    res.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "Content-Security-Policy": tauri.app.security.csp,
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const reports = [];
try {
  for (const scrollResult of (
    process.env.VEXSSH_REPRO_SCROLL || "promise,void"
  ).split(","))
    for (const expanded of process.env.VEXSSH_REPRO_EXPANDED
      ? [process.env.VEXSSH_REPRO_EXPANDED === "true"]
      : [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 1380, height: 900 },
      });
      await context.addInitScript(
        ({ fixture, expanded, scrollResult, injectError, persistConfig, currentVersion, terminalClipboard }) => {
          localStorage.setItem("nexssh.terminal.expanded", String(expanded));
          window.isTauri = true;
          const callbacks = new Map();
          const listeners = new Map();
          let serial = 0;
          const state = (window.fixture = {
            calls: [],
            events: [],
            config: persistConfig && localStorage.getItem("vexssh.fixture.config")
              ? JSON.parse(localStorage.getItem("vexssh.fixture.config"))
              : structuredClone(fixture.state_load),
            sessions: new Map(),
            themeApplications: [],
            update: { currentVersion, source: "local", canInstall: true, canCancel: false, pending: null, pendingError: null, lastResult: null },
          });
          if (injectError)
            state.config.snippets = [
              {
                id: "recovery-fixture",
                name: "Recovery fixture",
                command: "fixture_no_execute",
                category: "Test",
                scope: "global",
                favorite: false,
              },
            ];
          const originalScrollIntoView = Element.prototype.scrollIntoView;
          Element.prototype.scrollIntoView = function (options) {
            const result = originalScrollIntoView.call(this, options);
            return scrollResult === "promise"
              ? Promise.resolve(result)
              : undefined;
          };
          const emit = (event, payload) => {
            for (const [id, listener] of listeners)
              if (listener.event === event)
                callbacks.get(listener.handler)?.({ event, id, payload });
          };
          state.emit = emit;
          window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
            unregisterListener: (_event, id) => listeners.delete(id),
          };
          window.__TAURI_INTERNALS__ = {
            metadata: {
              currentWindow: { label: "main" },
              currentWebview: { label: "main" },
            },
            transformCallback(fn) {
              const id = ++serial;
              callbacks.set(id, fn);
              return id;
            },
            unregisterCallback(id) {
              callbacks.delete(id);
            },
            async invoke(command, args = {}) {
              state.calls.push({ command, args: structuredClone(args) });
              if (command === "plugin:event|listen") {
                const id = ++serial;
                listeners.set(id, args);
                state.events.push(args.event);
                return id;
              }
              if (command === "plugin:event|unlisten") {
                listeners.delete(args.eventId);
                return null;
              }
              if (command === "plugin:window|scale_factor") return 1;
              if (command === "plugin:dialog|open") return "C:\\fixture\\vexssh-update.zip";
              if (command !== "request")
                throw new Error("Unexpected native command " + command);
              const { action, payload = {} } = args;
              if (action === "state_load") return structuredClone(state.config);
              if (action === "serial_ports") return ["COM7", "COM9"];
              if (action === "serial_open") { state.serialPort = payload.id; return null; }
              if (action === "serial_close") { if (payload.id === state.serialPort) state.serialPort = null; return null; }
              if (action === "serial_write") {
                if (payload.id !== state.serialPort) throw new Error("Serial port is closed.");
                state.serialOutput = (state.serialOutput || "") + payload.text;
                return null;
              }
              if (action === "state_save") {
                state.config = structuredClone(payload.config);
                if (persistConfig) localStorage.setItem("vexssh.fixture.config", JSON.stringify(state.config));
                return { ok: true };
              }
              if (action === "keys_list" || action === "transfer_list")
                return structuredClone(fixture[action]);
              if (action === "identity_inspect")
                return { encrypted: false, algorithm: "ssh-ed25519" };
              if (action === "diagnostics_report") return { ok: true };
              if (action === "updates_status") return structuredClone(state.update);
              if (action === "updates_prepare") {
                if (state.holdUpdatePrepare) await new Promise(resolve => { state.releaseUpdatePrepare = resolve; });
                if (state.updateError) throw new Error(state.updateError);
                const numbers = currentVersion.split(".").map(Number);
                numbers[2]++;
                state.update.pending = { version: numbers.join("."), size: 12000000, sha256: "a".repeat(64), installOnExit: false };
                state.update.canCancel = true;
                state.update.pendingError = null;
                return structuredClone(state.update);
              }
              if (action === "updates_install_on_exit") {
                if (!state.update.pending) throw new Error("Choose an update package first");
                state.update.pending.installOnExit = true;
                return structuredClone(state.update);
              }
              if (action === "updates_cancel") {
                state.update.pending = null;
                state.update.canCancel = false;
                state.update.pendingError = null;
                return structuredClone(state.update);
              }
              if (action === "window_theme") {
                await new Promise((resolve) => setTimeout(resolve, payload.theme === "dark" ? 20 : 5));
                state.nativeTheme = payload.theme;
                state.themeApplications.push(payload.theme);
                return { ok: true };
              }
              if (action === "ssh_begin_connect" || action === "ssh_cancel_connect") return { ok: true };
              if (action === "ssh_connect") {
                if (payload.verifyOnly) return { verified: true };
                const sessionId = crypto.randomUUID();
                state.sessions.set(sessionId, payload.hostId);
                return {
                  sessionId,
                  hostId: payload.hostId,
                  routeToken: payload.hostId + ":" + (state.routeRevision || 1),
                  latencyMs: 3,
                  connectedAt: Date.now(),
                };
              }
              if (action === "ssh_attach") {
                emit("terminal-data", {
                  sessionId: payload.sessionId,
                  data: btoa((terminalClipboard ? "\x1b[?2004h" : "") + "fixture$ "),
                });
                return { ok: true };
              }
              if (action === "ssh_open_here") {
                const hostId = state.sessions.get(payload.sessionId);
                if (!hostId || !payload.path.startsWith("/")) throw new Error("Invalid source session or directory");
                const sessionId = crypto.randomUUID();
                state.sessions.set(sessionId, hostId);
                return {sessionId, latencyMs:3, routeToken: hostId + ":" + (state.routeRevision || 1)};
              }
              if (action === "ssh_check_path_target") {
                const hostId = state.sessions.get(payload.sourceId);
                if (!hostId || state.sessions.get(payload.targetId) !== hostId) throw new Error("Different hosts");
                if (state.holdTargetCheck) {
                  state.holdTargetCheck = false;
                  await new Promise(resolve => { state.finishTargetCheck = resolve; });
                }
                return null;
              }
              if (action === "ssh_resize") return { ok: true };
              if (action === "ssh_write") return { ok: true };
              if (action === "ssh_disconnect") {
                state.sessions.delete(payload.sessionId);
                return { ok: true };
              }
              if (action === "file_list") {
                const path =
                  payload.side === "remote"
                    ? "/var/home/test-user"
                    : "C:\\Users\\Test User";
                if (state.injectFileRenderError && payload.side === "remote")
                  return { path, entries: null };
                return {
                  path,
                  entries: [
                    ...(fixture.state_load.snippets.some(s => s.id === "pods") && payload.side === "remote"
                      ? [{name:"owner's report.log",path:path+"/owner's report.log",isDir:false,isSymlink:false,size:16,modified:1794450000,permissions:"644"}] : []),
                    {
                      name: "Documents",
                      path: path + "/Documents",
                      isDir: true,
                      isSymlink: false,
                      size: 4096,
                      modified: null,
                      permissions:
                        payload.side === "remote" ? null : "read/write",
                    },
                    {
                      name: ".profile",
                      path: path + "/.profile",
                      isDir: false,
                      isSymlink: false,
                      size: 13,
                      modified: 1794450000,
                      permissions: "644",
                    },
                  ],
                };
              }
              if (action === "transfer_start") return { id: "fixture-transfer", status: "queued" };
              throw new Error("Unexpected fixture action " + action);
            },
          };
        },
        {
          fixture,
          expanded,
          scrollResult,
          injectError: process.env.VEXSSH_INJECT_RENDER_ERROR === "1" || process.env.VEXSSH_TERMINAL_RETRY === "1",
          persistConfig: process.env.VEXSSH_ENHANCEMENTS === "1" || process.env.VEXSSH_SIDEBAR_NAVIGATION === "1" || process.env.VEXSSH_TERMINAL_APPEARANCE === "1",
          currentVersion: tauri.version,
          terminalClipboard: process.env.VEXSSH_TERMINAL_CLIPBOARD === "1",
        },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      const consoleErrors = [];
      page.on("pageerror", (error) =>
        errors.push(error.stack || error.message),
      );
      page.on("console", (entry) => {
        if (entry.type() === "error") consoleErrors.push(entry.text());
      });
      const nav = (name) => page.locator(".sidebar").getByRole("button", { name, exact: true });
      async function paletteAction(name) {
        if (
          await page
            .getByRole("button", { name: "Restore layout", exact: true })
            .isVisible()
        ) {
          await page
            .getByRole("button", {
              name: "New terminal (Ctrl+Shift+T)",
              exact: true,
            })
            .click();
        } else {
          await nav("Terminal").click();
          await page
            .getByRole("button", {
              name: "New terminal (Ctrl+Shift+T)",
              exact: true,
            })
            .click();
        }
        const dialog = page.getByRole("dialog", {
          name: "Quick connect",
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole("button", { name: new RegExp("^" + name) })
          .click();
        await expect(dialog).not.toBeVisible();
        await expect(page.locator(".app-shell")).toBeVisible();
      }
      try {
        await page.goto(url);
        if (process.env.VEXSSH_TERMINAL_APPEARANCE === "1") {
          const { exerciseTerminalAppearance } = await import("./desktop-terminal-appearance.mjs");
          reports.push(await exerciseTerminalAppearance({page, expect, fixture, nav}));
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
          continue;
        }
        if (process.env.VEXSSH_SERIAL === "1") {
          const { exerciseSerial } = await import("./desktop-serial.mjs");
          await exerciseSerial({ page, expect });
          assert.deepEqual(errors, []);
          reports.push({ serial: "passed", expanded });
          continue;
        }
        if (process.env.VEXSSH_IMMERSIVE === "1") {
          const { exerciseImmersive } = await import("./desktop-immersive.mjs");
          reports.push({immersive:await exerciseImmersive({page, expect, fixture})});
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
          continue;
        }
        if (process.env.VEXSSH_WINDOW_SCROLL === "1") {
          const { exerciseWindowScroll } = await import("./desktop-window-scroll.mjs");
          reports.push({windowScroll:await exerciseWindowScroll({page, expect,nav}), errors});
          assert.deepEqual(errors, []);
          continue;
        }
        if (process.env.VEXSSH_MIXED_VIEWS === "1") {
          const { exerciseMixedViews } = await import("./desktop-mixed-views.mjs");
          await exerciseMixedViews({ page, expect, fixture, nav });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
          reports.push({ mixedViews: "passed", expanded });
          continue;
        }
        await expect(
          page.getByRole("heading", { name: "Your hosts", exact: true }),
        ).toBeVisible();
        await paletteAction("Open new terminal");
        await expect(
          page.getByRole("heading", { name: "Your hosts", exact: true }),
        ).toBeVisible();
        await paletteAction("Open SFTP file manager");
        await expect(
          page.getByRole("heading", { name: "File manager", exact: true }),
        ).toBeVisible();
        await nav("Hosts").click();
        await page
          .locator(".connection-card")
          .filter({ hasText: fixture.state_load.hosts[0].hostname })
          .getByRole("button", { name: fixture.state_load.hosts[0].name, exact: true })
          .click();
        await expect(page.getByRole("tab")).toHaveCount(1);
        await expect(page.getByRole("dialog")).not.toBeVisible();
        // Preserve this regression matrix's docked/expanded starting layout.
        if (!expanded) await page.getByRole("button", {name:"Restore layout", exact:true}).click();
        for (let index = 0; index < 5; index++) {
          await paletteAction("Open new terminal");
          await expect(
            page.getByRole("heading", { name: "Your hosts", exact: true }),
          ).toBeVisible();
          await paletteAction("Open SFTP file manager");
          await expect(
            page.getByRole("heading", { name: "File manager", exact: true }),
          ).toBeVisible();
          await expect(page.locator('[data-file-side="remote"]')).toContainText(
            ".profile",
          );
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(consoleErrors, []);
        await expect(
          page.getByRole("button", { name: "Restore workspace", exact: true }),
        ).toHaveCount(0);
        assert.equal(
          await page.evaluate(
            () =>
              window.fixture.calls.filter(
                (call) => call.args?.action === "diagnostics_report",
              ).length,
          ),
          0,
        );
        let recovery;
        let tabReordering;
        let enhancements;
        let terminalRetry;
        let terminalClipboard;
        let remoteTerminal;
        let filesDrag;
        let sessionNavigation;
        let remoteDrawer;
        if (process.env.VEXSSH_SESSION_TARGETS === "1") {
          const { exerciseSessionTargets } = await import("./desktop-session-targets.mjs");
          await exerciseSessionTargets({ page, expect, nav, fixture });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_THEME_MODES === "1") {
          await nav("Terminal").click();
          const pane = page.locator(".terminal-pane.focused:visible");
          const session = await pane.getAttribute("data-session-id");
          for (const [theme, background] of [["light", "rgb(248, 250, 253)"], ["dark", "rgb(11, 13, 18)"]]) {
            const action = "Switch to " + theme + " mode";
            if (await nav(action).isVisible()) await nav(action).click();
            else await paletteAction(action);
            await expect.poll(() => page.evaluate(() => window.fixture.config.settings.theme)).toBe(theme);
            await expect.poll(() => page.evaluate(() => window.fixture.nativeTheme)).toBe(theme);
            await expect(pane).toHaveCSS("background-color", background);
            await expect(pane).toHaveAttribute("data-session-id", session);
            await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
          }
        }
        if (process.env.VEXSSH_SFTP_SQL === "1") {
          const { exerciseSftpSql } = await import("./desktop-sftp-sql.mjs");
          await exerciseSftpSql({page, expect, nav});
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_DATABASES === "1") {
          const { exerciseDatabases } = await import("./desktop-databases.mjs");
          await exerciseDatabases({page, expect, nav, paletteAction});
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        let drawerResize;
        let drawerDownload;
        if (process.env.VEXSSH_DRAWER_DOWNLOAD === "1") {
          const { exerciseDrawerDownload } = await import("./desktop-drawer-download.mjs");
          drawerDownload = await exerciseDrawerDownload({page, expect, fixture});
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_DRAWER_RESIZE === "1") {
          drawerResize = await exerciseDrawerResize({page, expect});
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        let pathLinks;
        let relativeLinks;
        if (process.env.VEXSSH_RELATIVE_PATHS === "1") {
          relativeLinks = await exerciseRelativeLinks({page,expect,fixture});
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_PATH_LINKS === "1") {
          pathLinks = await exercisePathLinks({page,expect,fixture});
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        let shellFiles;
        if (process.env.VEXSSH_SHELL_FILES === "1") {
          shellFiles = await exerciseShellFiles({ page, expect, fixture });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_REMOTE_DRAWER === "1") {
          remoteDrawer = await exerciseRemoteDrawer({ page, expect, fixture });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        let sessionHistory;
        if (process.env.VEXSSH_SESSION_HISTORY === "1") {
          sessionHistory = await exerciseSessionHistory({ page, expect, fixture });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_SESSION_NAVIGATION === "1") {
          sessionNavigation = await exerciseSessionNavigation({ page, expect, fixture, nav });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_REMOTE_TERMINAL === "1") {
          remoteTerminal = await exerciseRemoteTerminalActions({ page, expect, fixture, nav });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_TERMINAL_CLIPBOARD === "1") {
          terminalClipboard = await exerciseTerminalClipboard({ page, expect, fixture, paletteAction });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_FILES_DRAG === "1") {
          filesDrag = await exerciseFilesDrag({ page, expect });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_ENHANCEMENTS === "1") {
          enhancements = await exerciseEnhancements({ page, expect, fixture, paletteAction });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_REORDER_TABS === "1") {
          tabReordering = await exerciseTabReordering({
            page,
            expect,
            fixture,
            paletteAction,
          });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        if (process.env.VEXSSH_TERMINAL_RETRY === "1") {
          terminalRetry = await exerciseTerminalRetry({ page, expect, fixture, paletteAction });
          assert.equal(consoleErrors.length, 1);
          assert(consoleErrors[0].includes("Injected terminal render failure"));
        }
        if (process.env.VEXSSH_INJECT_RENDER_ERROR === "1") {
          await nav("Snippets").click();
          await page
            .getByRole("button", { name: "Review & run", exact: true })
            .click();
          await page
            .getByRole("dialog", { name: "Review command", exact: true })
            .getByRole("button", { name: /^Execute on / })
            .click();
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  window.fixture.calls.filter(
                    (call) => call.args?.action === "ssh_write",
                  ).length,
              ),
            )
            .toBe(1);
          await paletteAction("Open SFTP file manager");
          const before = await page.evaluate(() => ({
            ids: [...window.fixture.sessions.keys()],
            calls: window.fixture.calls.length,
          }));
          await page.evaluate(() => {
            window.fixture.injectFileRenderError = true;
          });
          await page
            .getByRole("button", {
              name: "Refresh remote directory",
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("heading", {
              name: "Workspace display interrupted",
              exact: true,
            }),
          ).toBeVisible();
          const restore = page.getByRole("button", {
            name: "Restore workspace",
            exact: true,
          });
          if (process.env.VEXSSH_RECOVERY_CAPTURE) {
            await page.setViewportSize({ width: 760, height: 560 });
            for (const theme of ["dark", "light"]) {
              await page.evaluate((theme) => {
                document.documentElement.dataset.theme = theme;
              }, theme);
              await restore.focus();
              await page.keyboard.press("Shift+Tab");
              await page.keyboard.press("Tab");
              await expect(restore).toBeFocused();
              await restore.evaluate((button) =>
                Promise.all(
                  button.getAnimations().map((animation) => animation.finished),
                ),
              );
              assert(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth,
                ),
              );
              await page.screenshot({
                path: resolve(
                  process.env.VEXSSH_RECOVERY_CAPTURE,
                  `workspace-recovery-${theme}.png`,
                ),
              });
            }
          }
          await page.evaluate(() => {
            window.fixture.injectFileRenderError = false;
          });
          await restore.focus();
          await page.keyboard.press("Enter");
          await expect(
            page.getByRole("heading", { name: "Your hosts", exact: true }),
          ).toBeVisible();
          await nav("Terminal").click();
          await expect(page.getByRole("tab")).toHaveCount(1);
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          const after = await page.evaluate(
            (start) => ({
              ids: [...window.fixture.sessions.keys()],
              actions: window.fixture.calls
                .slice(start)
                .map((call) => call.args?.action),
              diagnostics: window.fixture.calls
                .filter((call) => call.args?.action === "diagnostics_report")
                .map((call) => call.args.payload),
            }),
            before.calls,
          );
          assert.deepEqual(after.ids, before.ids);
          assert(
            !after.actions.includes("ssh_connect") &&
              !after.actions.includes("ssh_disconnect") &&
              !after.actions.includes("ssh_write"),
          );
          assert(
            after.diagnostics.some(
              (item) =>
                item.category === "react" && item.errorClass === "TypeError",
            ),
          );
          recovery = {
            preservedSessionIds: true,
            noConnectDisconnectOrCommandReplay: true,
            diagnostics: after.diagnostics,
            expectedConsoleErrors: consoleErrors.length,
          };
          assert.equal(consoleErrors.length, 1);
        }
        assert.deepEqual(errors, []);
        let hostCards;
        if (process.env.VEXSSH_HOST_CARDS === "1") {
          const { exerciseHostCards } = await import("./desktop-host-cards.mjs");
          hostCards = await exerciseHostCards({ page, expect, fixture, nav, directory:process.env.VEXSSH_HOST_CAPTURE });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        let namedLayouts;
        if (process.env.VEXSSH_NAMED_LAYOUTS === "1") {
          const { exerciseNamedLayouts } = await import("./desktop-named-layouts.mjs");
          namedLayouts = await exerciseNamedLayouts({ page, expect, fixture, nav });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        let sidebarNavigation;
        if (process.env.VEXSSH_SIDEBAR_NAVIGATION === "1") {
          const { exerciseSidebarNavigation } = await import("./desktop-sidebar-navigation.mjs");
          sidebarNavigation = await exerciseSidebarNavigation({ page, expect, nav });
          assert.deepEqual(errors, []);
          assert.deepEqual(consoleErrors, []);
        }
        reports.push({
          expanded,
          scrollResult,
          result: "PASS",
          sidebarNavigation,
          namedLayouts,
          hostCards,
          version: tauri.version,
          unexpectedErrors: errors,
          recovery,
          tabReordering,
          enhancements,
          terminalRetry,
          terminalClipboard,
          remoteTerminal,
          sessionNavigation,
          remoteDrawer,
          drawerResize,
          drawerDownload,
          pathLinks,
          relativeLinks,
          shellFiles,
          sessionHistory,
          filesDrag,
          nativeEvents: await page.evaluate(() => [
            ...new Set(window.fixture.events),
          ]),
          sessionCount: await page.evaluate(() => window.fixture.sessions.size),
        });
      } catch (error) {
        console.log(
          JSON.stringify(
            {
              expanded,
              scrollResult,
              error: String(error),
              errors,
              consoleErrors,
              rootLength: await page
                .locator("#root")
                .innerHTML()
                .then((html) => html.length),
              bodyText: (await page.locator("body").innerText()).slice(0, 1800),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
