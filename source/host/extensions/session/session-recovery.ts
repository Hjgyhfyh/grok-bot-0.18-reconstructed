import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getSandProfilePath, readSandProfileFile, writeSandProfileFile, type SandAgentProfile } from "../../agents/agent-profile.js";
import { getSandSettingsPath, writeSandSettingsFile } from "../../agents/settings-file.js";
export class ConversationRecoveryScanError extends Error{constructor(readonly detail:string){super(`conversation recovery scan failed: ${detail}`);this.name="ConversationRecoveryScanError"}}
export function transcriptEntryMatchesRecovered(a:Record<string,unknown>,b:Record<string,unknown>):boolean{if(a.kind!==b.kind)return false;if(a.kind==="message")return a.role===b.role&&a.content===b.content;if(a.kind==="send-message")return isDeepStrictEqual(a.message,b.message);if(a.kind==="tool-call")return a.name===b.name&&a.status===b.status&&a.summary===b.summary;return false}
export function cacheBlobReads<T>(store:{getBlob(ctx:unknown,id:Uint8Array):Promise<T|null>;setBlob(ctx:unknown,id:Uint8Array,data:T):Promise<void>;flush(ctx:unknown):Promise<void>}){const reads=new Map<string,Promise<T|null>>(),key=(id:Uint8Array)=>Buffer.from(id).toString("hex");return{getBlob(ctx:unknown,id:Uint8Array){const k=key(id),cached=reads.get(k);if(cached)return cached;const read=store.getBlob(ctx,id);reads.set(k,read);return read},setBlob(ctx:unknown,id:Uint8Array,data:T){reads.set(key(id),Promise.resolve(data));return store.setBlob(ctx,id,data)},flush:(ctx:unknown)=>store.flush(ctx)}}
export interface ProfileStoreMirror{get(key:string):unknown;set?(key:string,value:unknown):boolean;getSandProfile?():{description?:string;avatarPath?:string|null};setSandProfile?(profile:{description:string;avatarPath:string|null}):boolean}
/**
 * Writes the identity `profile.json` holds back into the agent's own store.
 *
 * `profile.json` is the file the roster reads, and `store.db` is the only place
 * that survives its loss. Both were half of a loop: reading a profile copied
 * nothing into the store, so the store kept the `"New Agent"` that
 * `getDefaultAgentMetadata` seeded when the agent was created -- `materializeSession`
 * writes the name to the file and never to the store -- and the copy that did run,
 * on a profile that was no longer there, had nothing to copy and produced
 * `"New Agent"`. Measured on a live box: an agent called "Fossil Probe" lost its
 * `profile.json`, one `listAgents` renamed it "New Agent" with an empty
 * description, and the file on disk agreed, so the name was gone for good. Two
 * agents that live by name -- the project auditor and the idea collector -- are
 * the same case.
 *
 * The mirror is idempotent: `db.set` and `db.setSandProfile` both refuse to write
 * an unchanged value, so a roster pass over a settled agent does not touch
 * `store.db` and cannot churn the mtime its own read cache is keyed on. This is
 * the same line `session-maintenance.ts` runs when a conversation is recovered,
 * reached from the read path instead of from the recovery path.
 */
function mirrorProfileIntoStore(db:ProfileStoreMirror,profile:SandAgentProfile):void{const name=profile.name.trim();if(name.length>0&&db.get("name")!==name)db.set?.("name",name);const description=profile.description.trim(),current=db.getSandProfile?.();if(current==null||db.setSandProfile==null||current.description===description)return;db.setSandProfile({description,avatarPath:current.avatarPath??null})}
/**
 * Makes sure the agent has a `profile.json`, and keeps the store in step with it.
 *
 * The rebuild half used to write through `writeSandProfileFile`, which runs
 * `mkdirSync` on the directory it is handed. Wave 9 moved directory creation out
 * of every read and into the mint, because a directory that comes back for an
 * agent nobody has holds a slot of the fifty-agent cap that the roster never
 * shows and the user cannot delete -- and this function was the last reader left
 * that could still make one. Every caller reaches it with a store that is open,
 * and an open store needs its directory, so the guard costs no live path and
 * closes the only one that did not: a name for an agent that is not there is not
 * worth a folder that says it is.
 */
export function ensureProfileFile(dbPath:string,db:ProfileStoreMirror):string{const path=getSandProfilePath(dirname(dbPath));if(!existsSync(path)){if(!existsSync(dirname(path)))return path;writeSandProfileFile(path,{name:String(db.get("name")||"Grok").trim()||"Grok",description:db.getSandProfile?.().description?.trim()??"",title:"",avatarShape:"",avatarColor:""});return path}const profile=readSandProfileFile(path);if(profile!=null)mirrorProfileIntoStore(db,profile);return path}
export function ensureSettingsFile(dbPath:string):string{const path=getSandSettingsPath(dirname(dbPath));if(!existsSync(path))writeSandSettingsFile(path,{});return path}
