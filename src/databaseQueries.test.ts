import { afterEach, describe, expect, it, vi } from "vitest";
import { bindHost, executionText, hostMatch, libraryKey, saveNamedQuery, savedQueries } from "./databaseQueries";
import { cleanProfile, connectionArgs, newProfile, presets } from "./databaseProfiles";
import type { Session } from "./types";

afterEach(() => vi.unstubAllGlobals());
describe("database workspace query state", () => {
  it("matches the same verified tab across SSH reconnects and keeps other tabs and routes distinct", () => {
    const session: Session = { id:"first", hostId:"bastion", name:"East", status:"connected", latencyMs:1, tabId:"stable",routeToken:"verified"};
    const binding = bindHost({sessionId:session.id,hostId:session.hostId,name:session.name},[session]);
    expect(hostMatch(binding,{...binding,sessionId:"replacement"})).toBe(true);
    expect(hostMatch(binding,{...binding,sessionId:"replacement",tabId:"another"})).toBe(false);
    expect(hostMatch(binding,{...binding,sessionId:"replacement",routeToken:"new-key"})).toBe(false);
    expect(hostMatch(binding,{...binding,hostId:"another"})).toBe(false);
  });
  it("runs an explicit selection, the whole statement for a caret, or nothing for a whitespace selection",()=>{
    const query = "SELECT 1; SELECT 2";
    expect(executionText(query,10,18)).toBe("SELECT 2");
    expect(executionText(query,3,3)).toBe(query);
    expect(executionText(query,9,10)).toBe("");
  });
  it("scopes and updates named queries by workspace and profile, preserving concurrent entries",()=>{
    const storage = new Map<string,string>();
    vi.stubGlobal("localStorage",{getItem:(k:string) => storage.get(k) || null,setItem:(k:string,v:string) => storage.set(k,v)});
    const key=libraryKey("one","profile"), second=libraryKey("two","profile");
    const saved=saveNamedQuery(key,undefined," Users ","SELECT 1");
    saveNamedQuery(key,undefined,"Status","SELECT 3");
    saveNamedQuery(key,saved.id,"Users","SELECT 2");
    expect(savedQueries(key).map(q=>q.text)).toEqual(["SELECT 2","SELECT 3"]);
    expect(savedQueries(second)).toEqual([]);
    expect(savedQueries(libraryKey("one","other"))).toEqual([]);
    expect(()=>saveNamedQuery(key,undefined,"users","SELECT 4")).toThrow(/already exists/);
  });
  it("migrates profile settings and sends effective read-only mode on every connection",()=>{
    const base=newProfile(presets[0],"one");
    expect(cleanProfile({...base,readOnly:undefined,production:undefined})?.readOnly).toBe(false);
    const production=cleanProfile({...base,readOnly:undefined,production:true})!;
    expect(connectionArgs(production,"","").readOnly).toBe(true);
    expect(cleanProfile({...production,readOnly:false})?.readOnly).toBe(false);
  });
});
