import { describe, expect, it } from "vitest";
import type { Host } from "./types";
import { fileSessionBinding } from "./fileSessions";

const host: Host = {
  id: "alpha",
  name: "Alpha",
  hostname: "alpha.example",
  username: "core",
  port: 22,
  authMethod: "key",
  keySource: "file",
  identityFile: "identity",
  workspaceId: "workspace",
  tags: [],
  color: "blue",
  notes: "",
  favorite: false,
};

describe("file session host binding", () => {
  it("requires reconnect when the address, user, or identity changes", () => {
    const original = fileSessionBinding(host.id, [host]);
    for (const change of [
      { hostname: "beta.example" },
      { username: "other" },
      { port: 2222 },
      { identityFile: "different-key" },
    ]) {
      expect(fileSessionBinding(host.id, [{ ...host, ...change }])).not.toBe(
        original,
      );
    }
  });
  it("keeps a session valid after changing display metadata", () => {
    expect(
      fileSessionBinding(host.id, [
        { ...host, name: "Renamed", notes: "new note", favorite: true },
      ]),
    ).toBe(fileSessionBinding(host.id, [host]));
  });
  it("detects changes or deletion of a jump host", () => {
    const destination = { ...host, jumpHostId: "jump" };
    const jump = { ...host, id: "jump", hostname: "bastion.example" };
    const original = fileSessionBinding(destination.id, [destination, jump]);
    expect(
      fileSessionBinding(destination.id, [
        destination,
        { ...jump, hostname: "changed.example" },
      ]),
    ).not.toBe(original);
    expect(fileSessionBinding(destination.id, [destination])).not.toBe(
      original,
    );
  });
});
