import { describe, expect, it } from "vitest";
import { checksumFiles } from "./fileChecksums";
import { resumableOnTab } from "./transferRecovery";
import type { FileEntry, Session, Transfer } from "./types";

const file = (name: string, path: string): FileEntry => ({name, path, size: 42, modified: 0, isDir: false, isSymlink: false, permissions: ""});
const left = file("report", "C:/report");
const right = file("report", "/report");
const other = file("copy", "/copy");

describe("choosing files to verify", () => {
  it("accepts a remote selection with a local same-name counterpart and an explicit renamed pair", () => {
    expect(checksumFiles([left], [right, other], {local: [], remote: [right.path]})).toEqual({local:left, remote:right});
    expect(checksumFiles([left], [right, other], {local: [left.path], remote: [other.path]})).toEqual({local:left, remote:other});
  });
  it("rejects stale selections, directories, symlinks and ambiguous multi-selection", () => {
    expect(checksumFiles([left], [right], {local: ["missing"], remote: [right.path]})).toBeUndefined();
    for (const patch of [{isDir:true}, {isSymlink:true}]) {
      expect(checksumFiles([left], [{...right,...patch}], {local: [left.path], remote: []})).toBeUndefined();
    }
    expect(checksumFiles([left], [right, other], {local: [left.path], remote: [other.path,right.path]})).toBeUndefined();
  });
});

describe("resume from a verified tab", () => {
  const session: Session = {id:"socket-new",tabId:"tab-a",routeToken:"route-main",hostId:"host",name:"A",status:"connected",latencyMs:1};
  const transfer: Transfer = {id:"job",sessionId:"socket-old",tabId:"tab-a",routeToken:"route-main",status:"failed",protocol:"sftp",resumable:true,
    source:"/a",destination:"C:/a",direction:"download",totalBytes:8,transferredBytes:4,speedBytesPerSecond:0,etaSeconds:null,startedAt:0};
  it("follows the original tab through reconnect and hides sibling/changed/offline tabs", () => {
    expect(resumableOnTab(session,[transfer])).toEqual([transfer]);
    for (const patch of [{tabId:"tab-b"}, {status:"disconnected"}, {routeToken:"different"}, {routeToken:undefined}]) {
      expect(resumableOnTab({...session,...patch},[transfer])).toEqual([]);
    }
  });
  it("shows only saved SFTP partials and allows an older record mapped to the exact current session", () => {
    const old = {...transfer,tabId:undefined};
    expect(resumableOnTab(session,[old])).toEqual([]);
    const mapped = {...old,sessionId:session.id};
    expect(resumableOnTab(session,[mapped])).toEqual([mapped]);
    for (const patch of [{protocol:"scp"}, {status:"completed"}, {resumable:false}, {routeToken:null}]) {
      expect(resumableOnTab(session,[{...transfer,...patch}])).toEqual([]);
    }
  });
});
