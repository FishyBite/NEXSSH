// Companion to windows-rc7-upgrade.ps1. The fixture runs against an installed
// release WebView so its native vault, persisted browser data and CSP are in use.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

const [mode, brand, port, snapshotPath] = process.argv.slice(2);
assert.ok((mode === "seed" && brand === "NEXSSH") || (mode === "verify" && brand === "VEXSSH"));
assert.match(port, /^\d{1,5}$/);
const endpoint = `http://127.0.0.1:${port}`;
await expect.poll(async () => {
  try { return (await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}, { timeout: 45000 }).toBe(true);

const browser = await chromium.connectOverCDP(endpoint);
try {
  let page;
  for (let attempt = 0; attempt < 80 && !page; attempt++) {
    page = browser.contexts().flatMap(context => context.pages())
      .find(p => /^https?:\/\/tauri\.localhost(?:\/|$)/.test(p.url()));
    if (!page) await delay(250);
  }
  assert.ok(page, "The installed release did not open its local app page");
  await expect(page).toHaveTitle(brand);
  await expect(page.locator(".brand")).toContainText(brand);
  const previous = mode === "verify" ? JSON.parse(await readFile(snapshotPath, "utf8")) : null;
  const result = await page.evaluate(async ({ mode, previous }) => {
    const request = (action, payload = {}) => window.__TAURI_INTERNALS__.invoke("request", { action, payload });
    const config = await request("state_load");
    const host = { id: "rc7-fixture", name: "Upgrade test host", hostname: "upgrade.invalid", username: "fixture", port: 22, workspaceId: "personal" };
    const storageKey = "nexssh.db.profiles.v1.personal";
    const profiles = JSON.stringify([{ id: "rc7-local", name: "Upgrade fixture", engine: "sqlite", path: "fixture.sqlite" }]);
    let key;
    if (mode === "seed") {
      if (config.hosts.length || (await request("keys_list")).length || localStorage.getItem(storageKey)) {
        throw new Error("Fixture refused an existing host, key or database profile");
      }
      key = await request("keys_generate", { name: "RC7 synthetic upgrade key", type: "ed25519" });
      config.hosts = [{ ...host, authMethod: "key", keySource: "stored", keyId: key.id }];
      config.settings.theme = "light";
      await request("state_save", { config });
      localStorage.setItem(storageKey, profiles);
    } else {
      if (!config.hosts.some(h => h.id === host.id && h.hostname === host.hostname && h.keyId === previous.id) ||
          config.settings.theme !== "light" || localStorage.getItem(storageKey) !== profiles) {
        throw new Error("Saved host, key reference, theme or WebView profile changed");
      }
      key = (await request("keys_list")).find(k => k.id === previous.id);
      if (!key || key.fingerprint !== previous.fingerprint) throw new Error("RC7 SSH identity changed");
    }
    const inspected = await request("identity_inspect", { keyId: key.id });
    if (inspected.algorithm !== "ssh-ed25519") throw new Error("Cannot reopen the stored RC7 private key");
    return { id: key.id, fingerprint: key.fingerprint };
  }, { mode, previous });
  const db = new DatabaseSync(join(process.env.APPDATA, "com.nexssh.desktop", "nexssh.sqlite3"), { readOnly: true });
  try {
    const row = db.prepare("SELECT ciphertext FROM secrets WHERE id = ?").get("key:" + result.id);
    assert.ok(row?.ciphertext.length > 28, "Missing persisted vault ciphertext");
    result.ciphertextHash = createHash("sha256").update(row.ciphertext).digest("hex");
  } finally {
    db.close();
  }
  if (previous) {
    assert.deepEqual(result, previous);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  } else {
    await writeFile(snapshotPath, JSON.stringify(result), { flag: "wx" });
  }
} finally {
  await browser.close();
}
