// Native IPC checks for the two isolated SFTP servers in run_relay_integration.py.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const cdp = process.env.VEXSSH_RELAY_TEST_CDP;
assert.match(cdp, /^http:\/\/127\.0\.0\.1:\d+$/);
const endpoints = JSON.parse(process.env.VEXSSH_RELAY_TEST_ENDPOINTS);
let browser;
let page;
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    browser ??= await chromium.connectOverCDP(cdp, { timeout: 1000 });
    page = browser.contexts()[0].pages().find(p => new URL(p.url()).hostname === "tauri.localhost");
    if (page && await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__?.invoke))) break;
  } catch { /* WebView2 is still opening its debug endpoint. */ }
  await delay(150);
}
assert.ok(page, "The disposable desktop app must load its embedded frontend");

const invoke = (action, payload = {}) => page.evaluate(([action, payload]) =>
  window.__TAURI_INTERNALS__.invoke("request", {action, payload}), [action, payload]);

async function connect(host, fixture) {
  const handshake = async opts => {
    const attemptId = randomUUID();
    await invoke("ssh_begin_connect", {attemptId});
    return invoke("ssh_connect", {hostId:host.id, attemptId, cols:100, rows:30, ...opts});
  };
  const check = await handshake({});
  assert.equal(check.fingerprint, fixture.fingerprint);
  const auth = await handshake({trustFingerprint: fixture.fingerprint, trustHostId:host.id,
    trustHostname:host.hostname, trustPort:host.port});
  assert.equal(auth.credentialRequired, "password");
  const result = await handshake({credentialRouteToken:auth.routeToken, credentialHostId:host.id, password:fixture.password});
  assert.ok(result.sessionId);
  return result.sessionId;
}

async function waitForJob(id, accept, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let job;
  while (Date.now() < deadline) {
    job = (await invoke("transfer_list")).find(item => item.id === id);
    if (job && accept(job)) return job;
    if (job && ["failed", "cancelled", "skipped", "conflict"].includes(job.status)) {
      throw Error(`Unexpected transfer status ${job.status}: ${job.error || ""}`);
    }
    await delay(70);
  }
  throw Error(`Transfer timed out in state ${job?.status} after ${job?.transferredBytes} bytes`);
}

async function main() {
  const config = await invoke("state_load");
  assert.equal(config.hosts.length, 0, "Require an empty disposable profile");
  const hosts = endpoints.map(fixture => ({id:randomUUID(), name:fixture.username, hostname:"127.0.0.1",
    username:fixture.username, port:fixture.port, authMethod:"password",
    workspaceId:config.workspaces?.[0]?.id || "personal", favorite:false, tags:[]}));
  config.hosts = hosts;
  config.settings ??= {};
  config.settings.transferConcurrency = 2;
  await invoke("state_save", {config});
  const a = await connect(hosts[0], endpoints[0]);
  const b = await connect(hosts[1], endpoints[1]);
  assert.notEqual(a, b);
  const relay = (sourceSessionId, sessionId, source, destination) => invoke("transfer_start",
    {sessionId, sourceSessionId, direction:"relay", protocol:"sftp", source, destination});

  await assert.rejects(relay(a, a, "/source folder", "/out/same-session"));
  const [upload, reverse] = await Promise.all([
    relay(a, b, "/source folder", "/out/from A"),
    relay(b, a, "/source folder", "/out/from B"),
  ]);
  for (const [job, from, to, sourceHost, destHost] of [
    [upload, a, b, hosts[0], hosts[1]],
    [reverse, b, a, hosts[1], hosts[0]],
  ]) {
    const result = await waitForJob(job.id, j => j.status === "completed");
    assert.equal(result.sourceSessionId, from);
    assert.equal(result.sessionId, to);
    assert.equal(result.sourceHostId, sourceHost.id);
    assert.equal(result.hostId, destHost.id);
    assert.equal(result.transferredBytes, result.totalBytes);
    assert.ok(result.totalBytes >= 147017);
  }
  console.log("Concurrent A-to-B and B-to-A folder transfers passed.");

  const clash = await relay(a, b, "/source folder/nested/résumé.bin", "/out/conflict.bin");
  const conflict = await waitForJob(clash.id, j => j.status === "conflict");
  await invoke("transfer_resolve", {id:clash.id, token:conflict.conflict.token, choice:"skip"});
  const skipped = await waitForJob(clash.id, j => j.status === "skipped" || j.status === "completed");
  assert.ok(skipped.skippedFiles > 0 || skipped.status === "skipped");
  console.log("Conflict resolution preserved the existing destination.");

  config.settings.sftpUploadLimitKiB = 256;
  await invoke("state_save", {config});
  const interrupted = await relay(a, b, "/large.bin", "/out/resumed.bin");
  await waitForJob(interrupted.id, j => j.status === "running" && j.transferredBytes >= 65536);
  await invoke("transfer_cancel", {id:interrupted.id});
  const partial = await waitForJob(interrupted.id, j => j.status === "cancelled");
  assert.ok(partial.transferredBytes < partial.totalBytes && partial.resumable);
  const listing = await invoke("file_list", {side:"remote", sessionId:b, path:"/out"});
  assert.ok(!listing.entries.some(f => f.name === "resumed.bin"));
  // The same saved profile ID now points to a different, fully authenticated server.
  // Even a trusted replacement must never supply bytes to a previously queued relay.
  const original = hosts[0];
  const replacement = {...original, port:hosts[1].port, username:hosts[1].username};
  config.hosts = [replacement, hosts[1]];
  await invoke("state_save", {config});
  const wrongSession = await connect(replacement, endpoints[1]);
  await invoke("transfer_resume", {id:interrupted.id});
  const refused = await waitForJob(interrupted.id, j => j.status === "failed");
  assert.match(refused.error, /source host:.*changed/i);
  assert.ok(refused.resumable);
  assert.equal(refused.transferredBytes, 0);
  const afterRefusal = await invoke("file_list", {side:"remote", sessionId:b, path:"/out"});
  assert.ok(!afterRefusal.entries.some(f => f.name === "resumed.bin"));
  await invoke("ssh_disconnect", {sessionId:wrongSession});
  console.log("Previously queued relay rejected a different authenticated source under the same saved profile.");

  config.hosts = hosts;
  config.settings.sftpUploadLimitKiB = 0;
  await invoke("state_save", {config});
  const originalSession = await connect(original, endpoints[0]);
  await invoke("transfer_resume", {id:interrupted.id});
  const completed = await waitForJob(interrupted.id, j => j.status === "completed");
  assert.ok(completed.resumedBytes > 0);
  console.log(`Cancelled partial was resumed at ${completed.resumedBytes} bytes.`);
  await Promise.all([a,b,originalSession].map(sessionId => invoke("ssh_disconnect", {sessionId})));
}

try { await main(); } finally { await browser?.close(); }
