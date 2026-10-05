import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_BEFORE = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const REGISTRY_AFTER = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"router",label:"Router",icon:"git-branch"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const GENERAL_BEFORE = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null';
const GENERAL_AFTER = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):x==="router"?a.jsx(RRouterPanel,{}):null';
const USAGE_BEFORE = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null';
const USAGE_AFTER = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(RRouterUsage,{})}):null';
const COMPONENT_ANCHOR = 'function Sa(s){';
// `$zn()` is the renderer root guard, and it is the only place the firstRun
// phase is turned into pixels:
//
//   n ? <client-pause/>                                        // sand_client_pause
//     : phase === "checking" ? null                             // <- a blank window
//     : <chrome>{ phase === "onboarding" ? <eDn/> : <Gzn/> }</chrome>
//
// Measured against the packaged build: `getCursorAuthStatus()` answers
// `{kind:"logged-out"}` in well under a second, so the gate settles into
// `phase === "onboarding"` (hUn returns gate "sign-in"/"onboarding", yUn maps
// anything that is not shell+signed-in to kind "onboarding"). The old patch
// already rendered `Gzn` in that phase, which is what un-blanked the window.
//
// The `phase === "checking" ? null` branch is still a second way to get a
// blank window: it is taken from the very first render until the gate settles,
// and forever if the firstRun store never connects. The shell itself does not
// read `phase` (only $zn and the onboarding-run store do), so mounting Gzn one
// branch earlier cannot half-initialise it. This patch therefore drops both
// guards in one replacement, which makes an empty window unreachable.
//
// No auth is faked: `eDn` stays defined and no login/credential code is
// touched. Reaching the *state machine's* own "shell" kind still requires a
// real signed-in Cursor account; this only stops that from being a render gate.
const SIGNIN_GATE_BEFORE = ':e==="checking"?null:p.jsx(JBn,{chrome:Hzn,children:e==="onboarding"?p.jsx(eDn,{onComplete:s,presentation:lzn},t):p.jsx(Gzn,{})})}';
const SIGNIN_GATE_AFTER = ':p.jsx(JBn,{chrome:Hzn,children:p.jsx(Gzn,{})})}';
// The account chip in the app shell, `_ln(n)`. Measured live over CDP against the packaged
// build: with no Cursor account it renders the literal text "Not signed in", which is the one
// piece of UI that still tells the user to register. Only the displayed label changes; the
// `isSignedIn:!1` flag is left exactly as it was, because callers branch on it and this build
// has no local agent store to promote it into a real session.
const NOT_SIGNED_IN_CHIP_BEFORE = 'name:e.kind==="logging-in"?"Signing in":"Not signed in",monogram:"?",avatarDataUrl:null,isSignedIn:!1}';
const NOT_SIGNED_IN_CHIP_AFTER = 'name:e.kind==="logging-in"?"Signing in":"Local",monogram:"?",avatarDataUrl:null,isSignedIn:!1}';
// The same words again in the Settings row, a different chunk. Its description told the user
// to connect an account; with a custom endpoint that instruction is simply wrong.
const NOT_SIGNED_IN_ROW_BEFORE = '(p="Not signed in",b="Connect your Cursor account to Grok Bot")';
const NOT_SIGNED_IN_ROW_AFTER = '(p="Local",b="Using your own endpoint")';
// The roster is fetched only when this mapper produces a non-empty account slot. Signed out it
// produced null, so `roster.connect()` — the one and only caller of listAgents — never ran, and
// the sidebar read "No saved agents yet." while the host sat there with a working local agent
// store and a live coordinator. A local slot is what lets the roster load with no Cursor account.
// It is a real string rather than a flag because the same value is what scopes settings and keys
// account-scoped persistence; an empty slot would leave those unscoped rather than locally owned.
// A signed-in account still wins: the `authId ?? email` branch is untouched.
const ACCOUNT_SLOT_BEFORE = 'function dde(n){if(n.kind!=="logged-in")return null;const e=n.authId??n.email;return e==null||e.length===0?null:e}';
const ACCOUNT_SLOT_AFTER = 'function dde(n){if(n.kind!=="logged-in")return "local";const e=n.authId??n.email;return e==null||e.length===0?"local":e}';
// A branched entry whose thread root is outside the loaded transcript window. The renderer
// loaded only the newest tail (`X0t=500`) and, unlike the host, never asks for a thread
// by id, so it cannot tell "my root is older than the window" from "my root is gone".
// `N_n` answered that ambiguity by deleting the entry: `mayHoldOlderHistory` made it skip
// `i.push(c)`, which is both the main feed and the thread summary. A message the user had
// just sent therefore vanished from the screen with no chip, no row and nothing to click,
// and the agent's branched reply went with it. The host resolves the same question the
// other way round (`getMainTranscriptEntries` in source/shared/transcript.ts hides a
// branched entry only once `resolveBranchRoot` actually found its root), so the orphaned
// entry is kept here too. It renders as an ordinary row with its reply quote; the moment
// "load older" brings the root in, `N_n` folds it back into its thread by itself.
const ORPHANED_BRANCH_BEFORE = 'if(u==null){if(t){r=!0;continue}i.push(c);continue}';
const ORPHANED_BRANCH_AFTER = 'if(u==null){r=!0;i.push(c);continue}';
// The open thread is dropped whenever its root id is not in the loaded entry map. The entry
// map is built from the same partial tail, so one transcript re-install was enough to close
// a live thread; `WGe(u, A)` still walks the branched children of a root it cannot see, so
// the thread itself was showing its messages correctly while this line threw the view away.
// The close is kept for the one case where it is genuinely right — a complete window in
// which the root really is not there — and is skipped whenever older history is still on
// offer, because then absence proves nothing.
const THREAD_CLOSE_BEFORE = '!d&&I!=null&&!Y.has(I)&&P(null),!d&&A!=null&&!Y.has(A)&&E(null)';
const THREAD_CLOSE_AFTER = '!d&&I!=null&&!Y.has(I)&&P(null),!d&&!f&&A!=null&&!Y.has(A)&&E(null)';
// Injected into the registry chunk, beside `h3n`, and using that chunk's own
// bindings: `S` (React), `p` (the jsx runtime), `Uwe` (the field the other three
// agent fields use), `vt` (the secondary/erroneous text component) and `lr` (the
// mutation wrapper that returns `{ok,value}` / `{ok,error}` instead of throwing).
// Nothing here is imported and nothing new is added to the chunk's scope except the
// two names below, which carry the `Rp` prefix of this patch.
//
// `lr` is used rather than a bare call so a refusal arrives as data. `updateAgent`
// refuses an over-long instruction with a sentence instead of shortening it
// (`AGENT_INSTRUCTIONS_MAX_BYTES`); an editor that swallowed that answer would show
// a saved-looking box for a brief the host refused to store, which is the exact
// shape of the defect this patch exists to close. `isPending` replaces the help line
// while the write is in flight so the two states are never confused.
export const AGENT_INSTRUCTIONS_COMPONENT_SOURCE = String.raw`
const RpAgentInstructionsLabel="sand-1y1aw1k sand-jkvuk6 sand-163pfp sand-y13l1i sand-1wm8ruf sand-spwq11 sand-19aaqeu";
function RpAgentInstructions(n){
  const{agent:e,roster:t}=n,
    {run:d,isPending:m}=lr(typeof t.updateAgent==="function"?t.updateAgent:async()=>{throw new Error("This build cannot save agent instructions.")}),
    [s,i]=S.useState(null),
    u=S.useCallback(l=>{
      const c=String(l??"").replace(/\r\n?/g,"\n").trim();
      if(c===(e.instructions??""))return;
      return d(e.id,{name:e.name,description:e.description,instructions:c}).then(a=>{i(a.ok?null:"Not saved: "+String(a.error?.message??a.error))})
    },[d,e.id,e.name,e.description,e.instructions]);
  if(e.isGroup)return null;
  const o=e.instructionsError??null;
  return p.jsxs(p.Fragment,{children:[
    p.jsx("div",{className:RpAgentInstructionsLabel,children:"Instructions"}),
    o===null?p.jsx(Uwe,{ariaLabel:"Agent instructions",initialValue:e.instructions??"",isMultiline:!0,onCommit:u,placeholder:"What this agent should always do"}):null,
    o===null?null:p.jsx(vt,{color:"red",size:"sm",children:o}),
    s===null?null:p.jsx(vt,{color:"red",size:"sm",children:s}),
    p.jsx(vt,{color:"secondary",size:"sm",children:m?"Saving\u2026":"Read by this agent on every turn."})
  ]})
}
`;
// The agent's own instruction text had nowhere to live in this build.
//
// The host half was finished first: `createAgent`/`updateAgent` carry an
// `instructions` string, `splitAgentInstructions` pulls it out of the profile so a
// later profile write cannot rebuild it away, and it lands in `instructions.md`
// beside `profile.json` and is read on every prompt build. Nothing was missing on
// the server. What was missing was a box.
//
// The agent dialog is `h3n`, in the registry chunk, and it is the one surface that
// already edits the other two things an agent IS: `h3n` renders "Name", "Title"
// and "Description" through the same `Uwe` field and commits each through a handler
// that the dialog's caller wires to `updateAgent`. Instructions were the fourth
// field, and the omission was invisible — the agent worked by the brief the user
// typed, the prompt said so, and the settings screen showed three short boxes and
// no sign that a fourth existed.
//
// The shape of the fix is the shape of the three fields above, deliberately: the
// same `Uwe` multiline field, the same label element and label classes, the same
// `updateAgent` call carrying `name`/`description` unchanged so a save cannot drop
// them. Only one thing is added around it, and it is the honest part: a file that
// is present but unreadable reports `instructionsError`, and that sentence is shown
// in place of an empty box. An empty box and "this agent has no brief" look
// identical, and that is the shape of the lie this avoids.
//
// Both anchors below are the shipped bytes and each occurs exactly once in
// `index-lA9cgT4O.js`, which `applyOriginalRendererRouterPatch` proves by refusing
// to patch a chunk where it is missing or ambiguous.
const AGENT_SETTINGS_HEAD_BEFORE =
  'function h3n(n){const e=he.c(31),{agent:t,onNameChange:s,onTitleChange:r,onDescriptionChange:i}=n,o=Qe().roster,{run:l,isPending:c}=lr(o.setAgentNotifyOnUpdates),u=S.useId();';
// The memo cache grows by one slot (31) because the description node now carries the
// instruction field with it. Reading slot 31 before anything writes it would still be
// safe on a plain array, but `he.c` is `React.useMemoCache`, which fills with -1 so
// that the compiler's own "has this slot ever been written" test works. Using an
// untouched slot would mean reading `undefined` where every other slot reads -1, so
// the size is bumped instead: the injected code then looks exactly like code the
// compiler wrote.
const AGENT_SETTINGS_HEAD_AFTER =
  `${AGENT_INSTRUCTIONS_COMPONENT_SOURCE}function h3n(n){const e=he.c(32),{agent:t,onNameChange:s,onTitleChange:r,onDescriptionChange:i}=n,o=Qe().roster,{run:l,isPending:c}=lr(o.setAgentNotifyOnUpdates),u=S.useId();`;
const AGENT_SETTINGS_DESCRIPTION_BEFORE =
  'let N;e[13]!==t.description||e[14]!==i?(N=p.jsx(Uwe,{ariaLabel:"Agent description",initialValue:t.description,isMultiline:!0,onCommit:i,placeholder:"What this agent is for"}),e[13]=t.description,e[14]=i,e[15]=N):N=e[15];';
// `t.instructions` joins the dependency test, and that is load-bearing rather than
// decorative. `h3n`'s nodes are memoised: without the extra term, saving an
// instruction updates the host, the roster emits a fresh row, `h3n` re-renders with
// a new `t` whose `name` and `description` are the SAME STRINGS, every slot still
// compares equal, and React reuses the identical element and never re-renders the
// field. The save would work and the screen would keep showing the old text until
// the dialog was reopened. The `initialValue` the field seeds from is
// `t.instructions`, and `sIe` re-syncs a draft that is not focused, so one extra
// term is what makes the box show what was just stored.
const AGENT_SETTINGS_DESCRIPTION_AFTER =
  'let N;e[13]!==t.description||e[14]!==i||e[31]!==t.instructions?(N=p.jsxs(p.Fragment,{children:[p.jsx(Uwe,{ariaLabel:"Agent description",initialValue:t.description,isMultiline:!0,onCommit:i,placeholder:"What this agent is for"}),p.jsx(RpAgentInstructions,{agent:t,roster:o})]}),e[13]=t.description,e[14]=i,e[31]=t.instructions,e[15]=N):N=e[15];';
export const COMPONENT_SOURCE = String.raw`
const RRouterProviders=[
  {value:"claude-code",label:"Claude Code",description:"Use your existing Claude Code sign-in and Grok Bot's connected plugins.",kind:"local",localKey:"claude-code"},
  {value:"codex",label:"Codex",description:"Use your existing ChatGPT sign-in from Codex with Grok Bot's connected plugins.",kind:"local",localKey:"codex"},
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY",credentialTitle:"OpenRouter account",credentialDescription:"Stored securely with your other Grok Bot secrets."},
  {value:"custom",label:"Custom",description:"Route through your own OpenAI-compatible endpoint.",kind:"custom",secret:"OPENAI_COMPATIBLE_API_KEY",credentialTitle:"Custom endpoint",credentialDescription:"Base URL and model id are saved with your other Grok Bot settings. The API key is stored securely as a Grok Bot secret."}
],RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,lastUsedAt:null},RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3",RRouterIsKeyed=s=>s.kind==="key"||s.kind==="custom",RRouterCredentialTitle=s=>s.credentialTitle??(RRouterIsKeyed(s)?s.label+" credentials":"Account"),RRouterCredentialLabel=s=>RRouterIsKeyed(s)?"API key":"Status",RRouterCredentialDescription=s=>s.credentialDescription??(s.value==="codex"?"Uses the private ChatGPT login already stored by Codex on this Mac. Requests are made by Grok Bot directly.":s.kind==="local"?"Uses Claude Code's existing login on this Mac.":RRouterIsKeyed(s)?"Stored securely with your other Grok Bot secrets.":"Uses the account already connected to Grok Bot."),RRouterFieldStyle={fontSize:13,height:34,minWidth:0,padding:"0 10px",width:"100%"},RRouterRowClass="sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",RRouterModelDebounceMs=350,RRouterModelLimit=2000,RRouterModelIdle=RRouterModelState("idle","",[],"",false,null),RRouterFallbackHost="opencode.ai",RRouterFallbackModels=["deepseek-v4-flash","deepseek-v4-flash-vision-exp","deepseek-v4-pro","deepseek-v4.1-flash","glm-5.2","glm-5.3","glm-5.3-flash","grok-4.5","grok-4.6","grok-4.7","gpt-5.6-luna","gpt-6-luna","hy3","hy4-preview","kimi-k2.6","kimi-k2.7-code","kimi-k3","longcat-2.0","longcat-2.5-preview-free","minimax-m2.7","minimax-m3","mimo-v2.5","mimo-v2.5-pro","mimo-v2.6-flash","mimo-v2.6-pro","muse-spark-1.2-contributor","muse-spark-1.3-contributor","qwen3.6-plus","qwen3.7-max","qwen3.7-plus","qwen3.8-flash","qwen3.8-max","space-bunny-free"],RRouterModelReasonText={"insecure-url":"only https, or http on localhost, can be probed","missing-credential":"no API key is stored for this endpoint yet",unauthorized:"the endpoint rejected the stored API key","http-status":"the endpoint answered with an error status","invalid-response":"the endpoint did not answer with an OpenAI-compatible model list","no-models":"the endpoint advertised no models",timeout:"the endpoint did not answer in time","network-error":"the endpoint could not be reached",unsupported:"this build cannot list models",unknown:"the endpoint could not be asked"};
function RRouterModelState(status,endpoint,models,source,truncated,reason){return{status,endpoint,models,source,truncated,reason}}
function RRouterModelHost(base){try{const host=new URL(base).host;return host.length>0?host:null}catch{return null}}
function RRouterModelProbe(base){const host=RRouterModelHost(base);if(host===null||base.indexOf("://")<0)return null;return{host,known:host===RRouterFallbackHost||host.endsWith("."+RRouterFallbackHost)}}
function RRouterModelOptions(list){if(!Array.isArray(list))return[];const out=[];for(let i=0;i<list.length&&out.length<RRouterModelLimit;i+=1){const entry=list[i],id=typeof entry==="string"?entry.trim():typeof entry?.id==="string"?entry.id.trim():"",raw=typeof entry==="string"?"":typeof entry?.name==="string"?entry.name.trim():"";if(id.length===0||out.some(j=>j.id===id))continue;out.push({id,name:raw.length>0&&raw!==id?raw:null})}return out}
function RRouterModelReason(reason){return typeof reason==="string"&&RRouterModelReasonText[reason]!=null?reason:"unknown"}
function RRouterModelListing(raw,probe){const endpoint=typeof raw?.endpoint==="string"&&raw.endpoint.trim().length>0?raw.endpoint.trim():probe.host,models=RRouterModelOptions(raw?.models);if(models.length>0)return RRouterModelState("ok",endpoint,models,"endpoint",raw?.truncated===true,null);const reason=RRouterModelReason(raw?.reason);return RRouterModelState("unavailable",endpoint,probe.known?RRouterFallbackModels:[],probe.known?"fallback":"",false,reason)}
function RRouterModelAbsent(list,id){return id.trim().length>0&&!list.some(j=>j.id===id.trim())}
function RRouterModelStatusText(state,list,id){if(state.status==="idle")return null;const absent=RRouterModelAbsent(list,id)?" “"+id.trim()+"” is not in that list, so it is kept exactly as you typed it.":"";if(state.status==="loading")return "Asking "+state.endpoint+" for its model list…";if(state.status==="ok")return list.length+" models from "+state.endpoint+"."+(state.truncated?" Only the first "+list.length+" are listed.":"")+absent;const why=RRouterModelReasonText[state.reason]??RRouterModelReasonText.unknown;return list.length>0?"Could not read the model list from "+state.endpoint+" ("+why+"). Showing "+list.length+" known "+RRouterFallbackHost+" models instead."+absent:"Could not read the model list from "+state.endpoint+" ("+why+"). Type the model id."+absent}
function RRouterModelSelect({listing:s,busy:n,modelId:t,onPick:o,onRetry:r}){const list=Array.isArray(s.models)?s.models:[],text=RRouterModelStatusText(s,list,t);return a.jsxs("div",{className:RRouterRowClass,style:{display:"flex",flexDirection:"column",gap:8,width:360},children:[text===null?null:a.jsx(se,{as:"p",color:s.status==="unavailable"?"red":"secondary",size:"sm",children:text}),list.length>0?a.jsx("select",{"aria-label":"Endpoint model list",className:RRouterInputClass,disabled:n,onChange:j=>{const value=j.currentTarget.value;if(value.length>0)o(value)},style:RRouterFieldStyle,value:RRouterModelAbsent(list,t)?"":t.trim(),children:[a.jsx("option",{key:"r-router-model-prompt",value:"",children:s.source==="fallback"?"Known "+RRouterFallbackHost+" models — the endpoint did not answer":"Choose a model from this endpoint"}),...list.map(j=>a.jsx("option",{key:"r-router-model-"+j.id,value:j.id,children:j.name==null?j.id:j.name+" — "+j.id}))]}):null,s.status==="unavailable"?a.jsxs("div",{className:RRouterRowClass,style:{width:360},children:[a.jsx(oe,{disabled:n,onClick:r,shape:"rectangular",size:"sm",variant:"secondary",children:"Try again"})]}):null]})}
function RRouterState(){
  const[s,e]=de.useState({provider:"custom",usage:null,local:null,endpoint:null,error:null});
  de.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:n,error:null}));try{const i=await window.desktop.agent.setInferenceRouter(n),o={...i,error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  return[s,t]
}
function RRouterSecrets(){const[s,e]=de.useState([]),[t,n]=de.useState(0);de.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])},p=>{r&&window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:{error:"Couldn't read the stored secrets: "+String(p?.message??p)}}))});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n}){const[r,i]=de.useState(""),[o,l]=de.useState(!1),[c,h]=de.useState(s.value),[u,f]=de.useState([e.endpoint?.baseUrl??"",e.endpoint?.modelId??""]);if(c!==s.value){h(s.value);f([e.endpoint?.baseUrl??"",e.endpoint?.modelId??""])}const[g,v]=u,[p,F]=de.useState(RRouterModelIdle),[j,b]=de.useState(0);de.useEffect(()=>{const base=g.trim(),probe=RRouterModelProbe(base);let live=true;if(probe===null){F(RRouterModelIdle);return}F(RRouterModelState("loading",probe.host,[],"",false,null));const timer=setTimeout(()=>{let call;try{call=window.desktop?.agent?.listInferenceRouterModels}catch{call=void 0}if(typeof call!=="function"){live&&F(RRouterModelState("unavailable",probe.host,probe.known?RRouterFallbackModels:[],probe.known?"fallback":"",false,"unsupported"));return}Promise.resolve().then(()=>call(base)).then(raw=>{if(live)F(RRouterModelListing(raw,probe))},()=>{if(live)F(RRouterModelState("unavailable",probe.host,probe.known?RRouterFallbackModels:[],probe.known?"fallback":"",false,"network-error"))})},RRouterModelDebounceMs);return()=>{live=false;clearTimeout(timer)}},[g.trim(),j]);if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated;return a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",children:d?"Ready":c?.installed?"Sign in with "+(s.value==="codex"?"codex login":"claude"):"Not installed"})}if(s.kind==="custom"){const m=g.trim().length>0,b=v.trim().length>0,k=t.includes(s.secret),C=async()=>{l(!0);try{const E={baseUrl:g.trim(),modelId:v.trim()};if(typeof window.desktop?.agent?.setInferenceRouter!=="function")throw new Error("This build cannot store a custom endpoint.");const p=await window.desktop.agent.setInferenceRouter(s.value,E);if(r.trim().length>0){await window.desktop.secrets.upsert({[s.secret]:r.trim()});i("");n()}window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:{...e,provider:s.value,endpoint:p?.endpoint??E,usage:p?.usage??e.usage,local:p?.local??e.local,error:null}}))}catch(p){window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:{...e,error:String(p?.message??p)}}))}finally{l(!1)}};return a.jsxs("div",{className:RRouterRowClass,style:{display:"flex",flexDirection:"column",gap:8,width:360},children:[a.jsx("input",{"aria-label":"Endpoint base URL",className:RRouterInputClass,disabled:o,onChange:j=>f([j.currentTarget.value,v]),placeholder:"Base URL, e.g. https://api.example.com/v1",style:RRouterFieldStyle,type:"text",value:g}),a.jsx("input",{"aria-label":"Endpoint model id",className:RRouterInputClass,disabled:o,onChange:j=>f([g,j.currentTarget.value]),placeholder:"Model id, e.g. my-model",style:RRouterFieldStyle,type:"text",value:v}),a.jsx(RRouterModelSelect,{busy:o,listing:p,modelId:v,onPick:j=>f([g,j]),onRetry:()=>b(x=>x+1)}),a.jsxs("div",{className:RRouterRowClass,style:{width:360},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:j=>i(j.currentTarget.value),placeholder:k?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o||!m||!b,onClick:C,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"})]}),a.jsx(se,{as:"p",color:"secondary",size:"sm",children:m&&b?k?"An API key is already stored. Paste a new one to replace it.":"The API key is stored securely with your other Grok Bot secrets.":"Both a base URL and a model id are required."})]})}const x=t.includes(s.secret),y=async()=>{if(r.trim().length===0)return;l(!0);try{await window.desktop.secrets.upsert({[s.secret]:r.trim()}),i(""),n()}catch(p){window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:{...e,error:"Couldn't store the API key: "+String(p?.message??p)}}))}finally{l(!1)}};return a.jsxs("div",{className:RRouterRowClass,style:{width:360},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:u=>i(u.currentTarget.value),placeholder:x?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o||r.trim().length===0,onClick:y,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"})]})}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function RBoxRuntime(){const[s,e]=de.useState({mode:"remote",status:null,error:null,busy:!0});de.useEffect(()=>{let t=!0;window.desktop.agent.getBoxRuntime().then(n=>{t&&e({...n,error:null,busy:!1})}).catch(n=>{t&&e(r=>({...r,error:String(n?.message??n),busy:!1}))});return()=>{t=!1}},[]);const t=s.mode==="local-docker",n=async()=>{const r=t?"remote":"local-docker";e(i=>({...i,mode:r,busy:!0,error:null}));try{const i=await window.desktop.agent.setBoxRuntime(r);e({...i,error:null,busy:!1})}catch(i){e(o=>({...o,mode:t?"local-docker":"remote",error:String(i?.message??i),busy:!1}))}};return a.jsxs("div",{children:[a.jsx(ie,{description:t?(s.status?.detail??"Shell, files and computer use run in a Docker container on this Mac."):"Shell, files and computer use run on Grok Bot's remote computer.",label:"Use local Docker VM",variant:"card",children:a.jsx("button",{"aria-checked":t,"aria-label":"Use local Docker VM",disabled:s.busy,onClick:n,role:"switch",style:{appearance:"none",background:t?"var(--color-accent-primary, #4f8cff)":"rgba(255,255,255,.14)",border:0,borderRadius:999,cursor:s.busy?"wait":"pointer",height:22,opacity:s.busy?0.65:1,padding:2,position:"relative",transition:"background .15s ease",width:38},type:"button",children:a.jsx("span",{style:{background:"white",borderRadius:"50%",boxShadow:"0 1px 3px rgba(0,0,0,.35)",display:"block",height:18,transform:"translateX("+(t?16:0)+"px)",transition:"transform .15s ease",width:18}})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function RRouterPanel(){const[s,e]=RRouterState(),[t,n]=RRouterSecrets(),r=RRouterProviders.find(i=>i.value===s.provider)??RRouterProviders[0],i=s.usage?.providers?.[s.provider]??RRouterEmptyUsage,o=RRouterCredentialDescription(r);return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"Routing",children:a.jsx(ie,{description:r.description,label:"Provider",variant:"card",children:a.jsx(ye,{"aria-label":"Routing provider",onValueChange:l=>{if(l!==null)void e(l)},options:RRouterOptions,placement:"bottom-end",size:"lg",value:s.provider,variant:"filled"})})}),a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),a.jsx(re,{title:RRouterCredentialTitle(r),children:a.jsx(ie,{description:o,label:RRouterCredentialLabel(r),variant:"card",children:a.jsx(RRouterCredential,{provider:r,state:s,keys:t,onSaved:n})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null,a.jsx(re,{title:"Usage for "+r.label,children:a.jsx(RRouterUsageRows,{usage:i})})]})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const[s]=RRouterState(),e=RRouterProviders.find(t=>t.value===s.provider)??RRouterProviders[0],t=RRouterProviders.filter(n=>n.value===s.provider||(s.usage?.providers?.[n.value]?.requests??0)>0);return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx("div",{children:t.map((n,r)=>a.jsx(RRouterUsageSummary,{provider:n,usage:s.usage?.providers?.[n.value]??RRouterEmptyUsage,current:n.value===s.provider,divided:r>0},n.value))})})]})}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`Original renderer ${label} anchor is missing or ambiguous.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchOriginalSettingsRegistry(source) {
  return replaceExactlyOnce(source, REGISTRY_BEFORE, REGISTRY_AFTER, "settings registry");
}

export function patchOriginalSettingsPanel(source) {
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  return patched;
}

export function patchOriginalSignInGate(source) {
  let patched = replaceExactlyOnce(source, SIGNIN_GATE_BEFORE, SIGNIN_GATE_AFTER, "sign-in gate");
  patched = replaceExactlyOnce(patched, NOT_SIGNED_IN_CHIP_BEFORE, NOT_SIGNED_IN_CHIP_AFTER, "account chip label");
  return patched;
}

export function patchOriginalAccountRow(source) {
  return replaceExactlyOnce(source, NOT_SIGNED_IN_ROW_BEFORE, NOT_SIGNED_IN_ROW_AFTER, "account row label");
}

export function patchOriginalAccountSlot(source) {
  return replaceExactlyOnce(source, ACCOUNT_SLOT_BEFORE, ACCOUNT_SLOT_AFTER, "account slot");
}

export function patchOriginalThreadSurfaces(source) {
  let patched = replaceExactlyOnce(source, ORPHANED_BRANCH_BEFORE, ORPHANED_BRANCH_AFTER, "orphaned branch entry");
  patched = replaceExactlyOnce(patched, THREAD_CLOSE_BEFORE, THREAD_CLOSE_AFTER, "open-thread close guard");
  return patched;
}

/**
 * Gives the agent settings dialog the fourth field it was missing.
 *
 * The head anchor is replaced first because it carries the injected component and
 * the one-byte cache-size bump; the description anchor is replaced second, and it
 * names that component. Both must hold, and `replaceExactlyOnce` throws on a chunk
 * where either is missing or appears twice, so a drifted upstream build fails here
 * rather than shipping a settings screen with no instructions field and no error.
 */
export function patchOriginalAgentInstructionsField(source) {
  let patched = replaceExactlyOnce(source, AGENT_SETTINGS_HEAD_BEFORE, AGENT_SETTINGS_HEAD_AFTER, "agent settings head");
  patched = replaceExactlyOnce(patched, AGENT_SETTINGS_DESCRIPTION_BEFORE, AGENT_SETTINGS_DESCRIPTION_AFTER, "agent settings description field");
  return patched;
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  const registryCandidates = [];
  const panelCandidates = [];
  const gateCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(REGISTRY_BEFORE)) registryCandidates.push({ name, target, source });
    if (source.includes(COMPONENT_ANCHOR) && source.includes(GENERAL_BEFORE) && source.includes(USAGE_BEFORE)) panelCandidates.push({ name, target, source });
    if (source.includes(SIGNIN_GATE_BEFORE)) gateCandidates.push({ name, target });
  }
  if (registryCandidates.length !== 1 || panelCandidates.length !== 1) {
    throw new Error(`Expected one original Settings registry and panel chunk, found ${registryCandidates.length}/${panelCandidates.length}.`);
  }
  // The gate lives in the renderer index chunk, the same one that carries the
  // Settings registry. Folding it into that chunk's transform keeps the
  // provenance record at two chunks, which is what the packaged-artifact
  // verifier accepts. A gate that drifted into another chunk is a hard failure
  // rather than a silently skipped transformation.
  if (gateCandidates.length !== 1 || gateCandidates[0].target !== registryCandidates[0].target) {
    throw new Error(`Expected one original sign-in gate chunk, and it must be the registry chunk ${registryCandidates[0].name}, found ${gateCandidates.length} in ${gateCandidates.map(entry => entry.name).join(", ") || "none"}.`);
  }
  const changes = [];
  for (const [role, candidate, transforms] of [
    ["registry", registryCandidates[0], [patchOriginalSettingsRegistry, patchOriginalSignInGate, patchOriginalAccountSlot, patchOriginalThreadSurfaces]],
    ["panel", panelCandidates[0], [patchOriginalSettingsPanel, patchOriginalAccountRow]],
  ]) {
    const patched = transforms.reduce((source, transform) => transform(source), candidate.source);
    await writeFile(candidate.target, patched);
    changes.push({
      role,
      path: `dist/renderer/assets/${candidate.name}`,
      original: { bytes: Buffer.byteLength(candidate.source), sha256: sha256(candidate.source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: changes,
    features: ["settings-router-provider", "settings-local-docker-vm", "usage-current-provider", "skip-signin-gate", "shell-during-boot-check", "no-account-nag", "local-roster-without-account", "endpoint-model-picker", "no-cursor-provider", "thread-orphan-stays-visible", "thread-survives-off-window-root", "agent-instructions-field"],
    transformations: ["settings-registry", "router-panel", "usage-panel", "component-source-injection", "signin-gate", "boot-check-gate", "account-chip-label", "account-row-label", "account-slot", "orphaned-branch-entry", "open-thread-close-guard", "agent-instructions-component-injection", "agent-instructions-field"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}
