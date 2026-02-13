import { useState, useRef, useCallback, useEffect } from "react";

// ─── Constants ───────────────────────────────────────────────────────
const EXTRACTION_MODES = [
  { id: "full", label: "Full Extract", desc: "Text, links, images, metadata, structured data", icon: "⬡" },
  { id: "text", label: "Text Only", desc: "Clean readable content, stripped of markup", icon: "¶" },
  { id: "links", label: "Links & Assets", desc: "Hyperlinks, images, scripts, stylesheets", icon: "⤴" },
  { id: "structured", label: "Structured", desc: "Tables, JSON-LD, OpenGraph, Schema.org", icon: "⊞" },
  { id: "developer", label: "Developer", desc: "Tech stack, DOM analysis, API endpoints", icon: "⌘" },
];

const CRAWL_SCOPES = [
  { id: "single", label: "Single Page", desc: "Just this URL", depth: "1 page" },
  { id: "connected", label: "Connected", desc: "URL + linked same-domain pages", depth: "~10 pages" },
  { id: "deep", label: "Deep Crawl", desc: "Recursive full-site crawl", depth: "up to 50" },
];

const EXPORT_FORMATS = [
  { id: "json", label: "JSON", ext: ".json", mime: "application/json" },
  { id: "csv", label: "CSV", ext: ".csv", mime: "text/csv" },
  { id: "markdown", label: "MD", ext: ".md", mime: "text/markdown" },
  { id: "html", label: "HTML", ext: ".html", mime: "text/html" },
  { id: "txt", label: "TXT", ext: ".txt", mime: "text/plain" },
  { id: "sql", label: "SQL", ext: ".sql", mime: "text/plain" },
];

// ─── Palette ─────────────────────────────────────────────────────────
const P = {
  // Backgrounds
  base: "#0f1117",
  raised: "#171921",
  elevated: "#1e2130",
  glass: "rgba(30, 33, 48, 0.7)",
  // Borders
  border: "rgba(255,255,255,0.06)",
  borderHover: "rgba(255,255,255,0.12)",
  borderActive: "rgba(232,186,99,0.3)",
  // Text
  white: "#f0ede6",
  cream: "#c8c3b8",
  muted: "#7d7a72",
  faint: "#44433e",
  // Accent — warm amber/gold
  accent: "#e8ba63",
  accentDim: "#c49a42",
  accentGlow: "rgba(232,186,99,0.15)",
  accentGlowStrong: "rgba(232,186,99,0.25)",
  // Semantic
  success: "#6fcf97",
  successDim: "rgba(111,207,151,0.12)",
  error: "#f07070",
  errorDim: "rgba(240,112,112,0.1)",
  errorBorder: "rgba(240,112,112,0.25)",
  // Type badges
  badge: "rgba(255,255,255,0.04)",
};

const TYPE_COLORS = {
  webpage:"#e8ba63",json:"#f0a050",csv:"#6fcf97",pdf:"#f07070",image:"#b07af0",
  xml:"#60a0f0",code:"#f070b0",audio:"#50d0c0",video:"#f08040",archive:"#8080f0",
  document:"#50b0e0",spreadsheet:"#60d080",
};

// ─── Utilities ───────────────────────────────────────────────────────
function detectUrlType(url) {
  const ext = url.toLowerCase().split("?")[0].split("#")[0].split(".").pop();
  const m = {json:"json",csv:"csv",tsv:"csv",xml:"xml",pdf:"pdf",png:"image",jpg:"image",jpeg:"image",gif:"image",webp:"image",svg:"image",mp3:"audio",wav:"audio",mp4:"video",webm:"video",zip:"archive",gz:"archive",js:"code",css:"code",py:"code",doc:"document",docx:"document",xls:"spreadsheet",xlsx:"spreadsheet"};
  return m[ext] || "webpage";
}
function getDomain(url) { try { return new URL(url).hostname; } catch { return ""; } }
function escapeCSV(v) { const s=String(v??""); return s.includes(",")||s.includes('"')||s.includes("\n")?`"${s.replace(/"/g,'""')}"`:s; }
function generateSQL(data, tn="scraped_data") {
  if(!data||typeof data!=="object") return "-- No data";
  const rows=Array.isArray(data)?data:[data]; if(!rows.length) return "-- Empty";
  const cols=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return `CREATE TABLE IF NOT EXISTS ${tn} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n${cols.map(c=>`  "${c}" TEXT`).join(",\n")}\n);\n\n`+rows.map(row=>`INSERT INTO ${tn} (${cols.map(c=>`"${c}"`).join(", ")}) VALUES (${cols.map(c=>{const v=row[c];return v==null?"NULL":`'${String(v).replace(/'/g,"''")}'`}).join(", ")});`).join("\n");
}
function convertToCSV(data) {
  if(!data||typeof data!=="object") return String(data);
  const rows=Array.isArray(data)?data:[data]; if(!rows.length) return "";
  const cols=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return cols.map(escapeCSV).join(",")+"\n"+rows.map(row=>cols.map(c=>escapeCSV(row[c])).join(",")).join("\n");
}
function convertToMarkdown(data) {
  if(typeof data==="string") return data; if(!data||typeof data!=="object") return String(data);
  const render=(obj,d=0)=>{let md="";if(Array.isArray(obj))obj.forEach((it,i)=>{if(typeof it==="object"&&it)md+=`${"#".repeat(Math.min(d+2,6))} Item ${i+1}\n\n${render(it,d+1)}\n`;else md+=`- ${it}\n`;});else if(typeof obj==="object"&&obj)Object.entries(obj).forEach(([k,v])=>{if(typeof v==="object"&&v)md+=`${"#".repeat(Math.min(d+2,6))} ${k}\n\n${render(v,d+1)}\n`;else md+=`**${k}:** ${v}\n\n`;});return md;};
  return `# Scraped Data\n\n${render(data)}`;
}
function downloadFile(content,filename,mime){const b=new Blob([content],{type:mime});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(u);}

// ─── API Engine ──────────────────────────────────────────────────────
async function callAPI(sys,usr){
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:8000,system:sys,messages:[{role:"user",content:usr}],tools:[{type:"web_search_20250305",name:"web_search"}]})});
  if(!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);return r.json();
}
function parseAPI(data){
  const text=data.content?.filter(b=>b.type==="text").map(b=>b.text).join("\n\n")||"";let structured=null;
  try{const m=text.match(/```json\s*([\s\S]*?)```/);if(m)structured=JSON.parse(m[1].trim());else{const c=text.replace(/^[^{[]*/,"").replace(/[^}\]]*$/,"");if(c.startsWith("{")||c.startsWith("["))structured=JSON.parse(c);}}catch{}
  return{rawText:text,structured,tokenUsage:data.usage};
}
function extractLinks(result,domain){
  const links=new Set();const find=(obj)=>{if(!obj)return;if(typeof obj==="string"){(obj.match(/https?:\/\/[^\s"'<>,)}\]]+/g)||[]).forEach(u=>{try{const p=new URL(u);if((p.hostname===domain||p.hostname.endsWith("."+domain))&&!p.pathname.match(/\.(png|jpg|jpeg|gif|css|js|ico|woff|mp3|mp4|pdf)$/i))links.add(p.origin+p.pathname)}catch{}});}else if(Array.isArray(obj))obj.forEach(find);else if(typeof obj==="object")Object.values(obj).forEach(find);};
  if(result.structured)find(result.structured);find(result.rawText);return[...links];
}

async function scrapeSingle(url,mode,onP){
  const ut=detectUrlType(url);onP(`Extracting: ${url}`);
  const data=await callAPI(buildSys(mode,ut),`Extract data from: ${url}\n\nURL type: ${ut} | Mode: ${mode}\n\nFetch via web search, extract and structure data. Return readable summary AND JSON in \`\`\`json fences.`);
  return{url,urlType:ut,mode,timestamp:new Date().toISOString(),...parseAPI(data)};
}
async function discoverPages(url,onP){
  const domain=getDomain(url);onP(`Mapping ${domain}...`);
  const data=await callAPI(`You are a web crawler. Find real pages for the given site. Return JSON:\n\`\`\`json\n{"discovered_urls":[{"url":"...","title":"..."}]}\n\`\`\``,`Discover all pages for: ${url}\nDomain: ${domain}\n\nSearch for sitemaps, blog posts, docs, help, products. Be thorough.`);
  const parsed=parseAPI(data);let urls=[];if(parsed.structured?.discovered_urls)urls=parsed.structured.discovered_urls.map(u=>typeof u==="string"?u:u.url).filter(Boolean);
  const textUrls=extractLinks(parsed,domain);const all=[...new Set([...urls,...textUrls])];onP(`Found ${all.length} pages`);return{urls:all};
}
async function crawlSite(url,mode,scope,max,onP,onDone,abort){
  const domain=getDomain(url),visited=new Set(),results=[],queue=[url];
  if(scope!=="single"){onP(`Discovering pages on ${domain}...`);try{const d=await discoverPages(url,onP);d.urls.forEach(u=>{if(!visited.has(u)&&!queue.includes(u))queue.push(u)});onP(`${queue.length} pages found (max: ${max})`)}catch(e){onP(`Discovery partial: ${e.message}`)}}
  const limit=scope==="single"?1:Math.min(queue.length,max);onP(`Scraping ${limit} page${limit>1?"s":""}...`);let n=0;
  while(queue.length>0&&n<max){if(abort.current){onP("Aborted.");break;}const cur=queue.shift();if(visited.has(cur))continue;visited.add(cur);n++;onP(`[${n}/${limit}] ${cur}`);
    try{const pr=await scrapeSingle(cur,mode,onP);results.push(pr);onDone(pr,n,limit);if(scope==="deep"&&n<max){let added=0;extractLinks(pr,domain).forEach(l=>{if(!visited.has(l)&&!queue.includes(l)){queue.push(l);added++}});if(added)onP(`  +${added} new links`)}}
    catch(e){onP(`  ✗ ${e.message}`);results.push({url:cur,urlType:detectUrlType(cur),mode,timestamp:new Date().toISOString(),rawText:`Error: ${e.message}`,structured:null,error:true})}
    if(queue.length>0&&n<max){await new Promise(r=>setTimeout(r,1500))}}
  return results;
}
function buildSys(mode,ut){
  const base=`You are a web data extraction engine. Fetch the URL via web search and extract data. Return a readable summary AND JSON in \`\`\`json fences.\nRules: extract REAL data only, never fabricate. Include discovered_links array.`;
  const modes={full:`\n\nFULL: Extract meta tags, OpenGraph, JSON-LD, text by headings, links, images, tables, structured data, assets.\nJSON: {"metadata":{},"text_content":{},"links":{},"images":[],"tables":[],"structured_data":{},"discovered_links":[]}`,text:`\n\nTEXT: Clean text organized by headings.\nJSON: {"metadata":{},"content":{"headings":[],"body":"","summary":""},"discovered_links":[]}`,links:`\n\nLINKS: All URLs — hyperlinks, images, scripts, stylesheets.\nJSON: {"metadata":{},"links":{},"images":[],"assets":{},"discovered_links":[]}`,structured:`\n\nSTRUCTURED: Tables, JSON-LD, Schema.org, OpenGraph.\nJSON: {"metadata":{},"tables":[],"json_ld":[],"opengraph":{},"discovered_links":[]}`,developer:`\n\nDEV: HTTP info, tech stack, DOM, API endpoints.\nJSON: {"http":{},"tech_stack":{},"api_endpoints":[],"resources":{},"discovered_links":[]}`};
  const files={json:"\nJSON file — parse fully.",csv:"\nCSV — parse into objects.",pdf:"\nPDF — extract text and metadata.",image:"\nImage — report metadata.",xml:"\nXML — convert to JSON.",code:"\nCode — identify language, analyze."};
  return base+(modes[mode]||modes.full)+(files[ut]||"");
}

// ─── Components ──────────────────────────────────────────────────────

function TypeBadge({type}){
  const c=TYPE_COLORS[type]||P.cream;
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",background:`${c}15`,color:c,border:`1px solid ${c}25`,fontFamily:"'DM Mono',monospace"}}><span style={{width:5,height:5,borderRadius:"50%",background:c,opacity:0.7}}/>{type}</span>;
}

function GrainOverlay(){
  return <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:9999,opacity:0.03,background:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`}}/>;
}

function ProgressLog({logs}){
  const ref=useRef(null);
  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight},[logs]);
  return(
    <div ref={ref} style={{fontFamily:"'DM Mono',monospace",fontSize:11,lineHeight:1.8,padding:"12px 16px",background:P.raised,borderRadius:10,border:`1px solid ${P.border}`,maxHeight:180,overflowY:"auto"}}>
      {logs.map((l,i)=>(
        <div key={i} style={{color:l.startsWith("[")?P.accent:l.includes("✗")?P.error:l.startsWith("✓")?P.success:i===logs.length-1?P.cream:P.muted}}>
          <span style={{color:P.faint,marginRight:8}}>{new Date().toLocaleTimeString("en-US",{hour12:false})}</span>{l}
        </div>
      ))}
      <span style={{display:"inline-block",width:7,height:14,background:P.accent,marginLeft:2,animation:"blink 1s step-end infinite",borderRadius:1}}/>
    </div>
  );
}

function CrawlBar({current,total,pages}){
  const pct=total>0?Math.round((current/total)*100):0;
  return(
    <div style={{marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
        <span style={{fontSize:13,fontWeight:700,color:P.white,fontFamily:"'Syne',sans-serif"}}>{current} of {total} pages</span>
        <span style={{fontSize:11,color:P.accent,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{pct}%</span>
      </div>
      <div style={{height:3,background:P.elevated,borderRadius:4,overflow:"hidden",position:"relative"}}>
        <div style={{height:"100%",width:`${pct}%`,background:`linear-gradient(90deg, ${P.accentDim}, ${P.accent})`,borderRadius:4,transition:"width 0.5s cubic-bezier(0.4,0,0.2,1)",boxShadow:`0 0 12px ${P.accentGlow}`}}/>
      </div>
      {pages.length>0&&(
        <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:10}}>
          {pages.map((p,i)=>(
            <span key={i} style={{fontSize:10,padding:"2px 8px",borderRadius:12,fontFamily:"'DM Mono',monospace",background:p.error?P.errorDim:P.successDim,color:p.error?P.error:P.success,border:`1px solid ${p.error?P.errorBorder:"rgba(111,207,151,0.2)"}`,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {p.error?"✗":"✓"} {(() => { try { return new URL(p.url).pathname||"/"; } catch { return p.url; } })()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultViewer({results,isSingle}){
  const [tab,setTab]=useState("preview");
  const [pg,setPg]=useState(0);
  const [exp,setExp]=useState({});
  const toggle=k=>setExp(p=>({...p,[k]:!p[k]}));
  const cur=isSingle?results[0]:results[pg];

  const renderData=(data,depth=0)=>{
    if(data==null)return<span style={{color:P.faint,fontStyle:"italic"}}>null</span>;
    if(typeof data==="string")return<span style={{color:P.cream,wordBreak:"break-word"}}>{data}</span>;
    if(typeof data==="number")return<span style={{color:P.accent}}>{data}</span>;
    if(typeof data==="boolean")return<span style={{color:P.success}}>{String(data)}</span>;
    if(Array.isArray(data)){
      if(!data.length)return<span style={{color:P.faint}}>[]</span>;
      if(data.every(d=>typeof d!=="object"))return<div style={{paddingLeft:depth>0?14:0}}>{data.map((it,i)=><div key={i} style={{padding:"2px 0",fontSize:12,color:P.cream}}><span style={{color:P.faint,marginRight:8,fontFamily:"'DM Mono',monospace",fontSize:10}}>{i}</span>{String(it)}</div>)}</div>;
      return<div style={{paddingLeft:depth>0?8:0}}>{data.slice(0,50).map((it,i)=><div key={i} style={{margin:"4px 0",padding:"8px 12px",background:P.elevated,borderRadius:8,border:`1px solid ${P.border}`}}><div style={{fontSize:10,color:P.faint,marginBottom:3,fontFamily:"'DM Mono',monospace"}}>#{i}</div>{renderData(it,depth+1)}</div>)}{data.length>50&&<div style={{color:P.muted,fontSize:11}}>...{data.length-50} more</div>}</div>;
    }
    if(typeof data==="object")return<div style={{paddingLeft:depth>0?10:0}}>{Object.entries(data).map(([k,v])=>{const cx=typeof v==="object"&&v!==null;const sk=`${depth}-${k}`;const open=exp[sk]!==false;return<div key={k} style={{margin:"2px 0"}}><div onClick={cx?()=>toggle(sk):undefined} style={{display:"flex",alignItems:"flex-start",gap:8,cursor:cx?"pointer":"default",padding:"3px 0",borderRadius:4}}>{cx&&<span style={{color:P.muted,fontSize:9,marginTop:4,transition:"transform 0.2s",transform:open?"rotate(0)":"rotate(-90deg)"}}>▼</span>}<span style={{color:P.accent,fontSize:11,fontWeight:600,fontFamily:"'DM Mono',monospace",minWidth:70,opacity:0.8}}>{k}</span>{!cx&&<span style={{color:P.cream,fontSize:12,wordBreak:"break-all"}}>{String(v)}</span>}{cx&&!open&&<span style={{color:P.faint,fontSize:11}}>{Array.isArray(v)?`[${v.length}]`:`{${Object.keys(v).length}}`}</span>}</div>{cx&&open&&<div style={{marginLeft:6,borderLeft:`1px solid ${P.border}`,paddingLeft:10}}>{renderData(v,depth+1)}</div>}</div>})}</div>;
    return<span>{String(data)}</span>;
  };

  const tabs=[{id:"preview",label:"Preview"},{id:"structured",label:"Data"},{id:"raw",label:"JSON"}];
  if(!isSingle)tabs.push({id:"aggregate",label:`All (${results.length})`});

  return(
    <div>
      {!isSingle&&tab!=="aggregate"&&(
        <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:14}}>
          {results.map((r,i)=>{let path="/";try{path=new URL(r.url).pathname||"/";}catch{}return(
            <button key={i} onClick={()=>setPg(i)} style={{padding:"4px 12px",fontSize:10,borderRadius:20,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:600,background:pg===i?P.accent:P.elevated,color:pg===i?P.base:r.error?P.error:P.cream,border:`1px solid ${pg===i?"transparent":P.border}`,maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",transition:"all 0.2s"}}>
              {r.error?"✗ ":""}{path}
            </button>
          );})}
        </div>
      )}
      <div style={{display:"flex",gap:0,borderBottom:`1px solid ${P.border}`,marginBottom:16}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"10px 18px",fontSize:12,fontWeight:tab===t.id?700:400,background:"none",border:"none",cursor:"pointer",color:tab===t.id?P.accent:P.muted,borderBottom:tab===t.id?`2px solid ${P.accent}`:"2px solid transparent",fontFamily:"'DM Mono',monospace",letterSpacing:0.3,transition:"all 0.2s"}}>{t.label}</button>
        ))}
      </div>
      <div style={{minHeight:200}}>
        {tab==="preview"&&cur&&<div><div style={{marginBottom:10,display:"flex",alignItems:"center",gap:8}}><TypeBadge type={cur.urlType}/><span style={{fontSize:11,color:P.muted,fontFamily:"'DM Mono',monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cur.url}</span></div><div style={{fontSize:14,lineHeight:1.85,color:P.cream,whiteSpace:"pre-wrap",wordBreak:"break-word",fontFamily:"'Georgia','Times New Roman',serif",letterSpacing:0.2}}>{cur.rawText||"No content."}</div></div>}
        {tab==="structured"&&cur&&(cur.structured?renderData(cur.structured):<div style={{color:P.muted,fontSize:13,padding:24,textAlign:"center",fontFamily:"'Georgia',serif",fontStyle:"italic"}}>No structured data parsed.</div>)}
        {tab==="raw"&&cur&&<pre style={{fontFamily:"'DM Mono',monospace",fontSize:11,lineHeight:1.6,color:P.cream,background:P.elevated,padding:16,borderRadius:10,border:`1px solid ${P.border}`,overflowX:"auto",maxHeight:500,overflowY:"auto",whiteSpace:"pre-wrap"}}>{JSON.stringify(cur.structured||{text:cur.rawText},null,2)}</pre>}
        {tab==="aggregate"&&<div><div style={{fontSize:13,color:P.muted,marginBottom:16,fontFamily:"'Syne',sans-serif"}}>{results.length} pages · {results.filter(r=>!r.error).length} ok · {results.filter(r=>r.error).length} failed</div>{results.map((r,i)=><div key={i} style={{marginBottom:8,padding:"12px 16px",background:r.error?P.errorDim:P.elevated,borderRadius:10,border:`1px solid ${r.error?P.errorBorder:P.border}`,display:"flex",alignItems:"center",gap:10}}><TypeBadge type={r.urlType}/><span style={{fontSize:12,fontWeight:600,color:P.white,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'DM Mono',monospace"}}>{r.url}</span><span style={{fontSize:10,fontWeight:700,color:r.error?P.error:P.success,fontFamily:"'DM Mono',monospace"}}>{r.error?"FAIL":"OK"}</span></div>)}</div>}
      </div>
    </div>
  );
}

function ExportPanel({results}){
  const [exp,setExp]=useState(null);
  const single=results.length===1;
  const handleExport=(fmt)=>{
    setExp(fmt.id);const domain=getDomain(results[0].url).replace(/\./g,"_");const fname=`scrape_${domain}_${results.length}pg_${Date.now()}${fmt.ext}`;
    const allS=results.filter(r=>r.structured).map(r=>({_source:r.url,...r.structured}));const allT=results.map(r=>`--- ${r.url} ---\n${r.rawText}`).join("\n\n");const agg=single?(results[0].structured||results[0].rawText):allS.length?allS:allT;
    let c;switch(fmt.id){case"json":c=JSON.stringify(single?(results[0].structured||{text:results[0].rawText}):{crawl:{pages:results.length,domain:getDomain(results[0].url)},pages:allS},null,2);break;case"csv":c=convertToCSV(agg);break;case"markdown":c=single?convertToMarkdown(agg):`# Crawl: ${getDomain(results[0].url)}\n\n`+results.map(r=>`## ${r.url}\n\n${r.rawText}`).join("\n\n---\n\n");break;case"html":c=`<!DOCTYPE html><html><head><title>Crawl</title></head><body>`+results.map(r=>`<h2>${r.url}</h2><pre>${r.rawText?.replace(/</g,"&lt;")}</pre>`).join("<hr/>")+`</body></html>`;break;case"txt":c=allT;break;case"sql":c=generateSQL(Array.isArray(agg)?agg:[agg]);break;default:c=JSON.stringify(agg,null,2)}
    downloadFile(c,fname,fmt.mime);setTimeout(()=>setExp(null),900);
  };
  return(
    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
      {EXPORT_FORMATS.map(f=>(
        <button key={f.id} onClick={()=>handleExport(f)} disabled={exp===f.id} style={{padding:"6px 14px",fontSize:11,fontWeight:600,fontFamily:"'DM Mono',monospace",letterSpacing:0.5,background:exp===f.id?P.accentGlow:"transparent",border:`1px solid ${exp===f.id?P.accent:P.border}`,borderRadius:20,color:exp===f.id?P.accent:P.muted,cursor:"pointer",transition:"all 0.2s"}}
          onMouseEnter={e=>{if(exp!==f.id){e.currentTarget.style.borderColor=P.borderHover;e.currentTarget.style.color=P.cream}}}
          onMouseLeave={e=>{if(exp!==f.id){e.currentTarget.style.borderColor=P.border;e.currentTarget.style.color=P.muted}}}>
          {exp===f.id?"✓":"↓"} {f.label}
        </button>
      ))}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────
export default function WebScraper(){
  const [url,setUrl]=useState("");
  const [mode,setMode]=useState("full");
  const [scope,setScope]=useState("single");
  const [maxPages,setMaxPages]=useState(10);
  const [loading,setLoading]=useState(false);
  const [logs,setLogs]=useState([]);
  const [results,setResults]=useState([]);
  const [error,setError]=useState(null);
  const [history,setHistory]=useState([]);
  const [showModes,setShowModes]=useState(false);
  const [showScope,setShowScope]=useState(false);
  const [crawlProg,setCrawlProg]=useState({current:0,total:0,pages:[]});
  const abort=useRef(false);

  const addLog=useCallback(m=>setLogs(p=>[...p,m]),[]);

  const handleScrape=async()=>{
    if(!url.trim())return;let target=url.trim();if(!/^https?:\/\//i.test(target))target="https://"+target;
    try{new URL(target)}catch{setError("Invalid URL.");return;}
    setLoading(true);setError(null);setResults([]);setLogs([]);abort.current=false;setCrawlProg({current:0,total:scope==="single"?1:maxPages,pages:[]});
    addLog(`Target: ${target}`);addLog(`Mode: ${EXTRACTION_MODES.find(m=>m.id===mode)?.label} · Scope: ${CRAWL_SCOPES.find(s=>s.id===scope)?.label}`);
    try{
      const cr=await crawlSite(target,mode,scope,scope==="single"?1:maxPages,addLog,(pr,cur,tot)=>{setCrawlProg(p=>({current:cur,total:Math.max(tot,p.total),pages:[...p.pages,{url:pr.url,error:pr.error}]}));setResults(p=>[...p,pr])},abort);
      if(!cr.length)throw new Error("No pages scraped.");
      setHistory(p=>[{url:target,mode,scope,pageCount:cr.length,timestamp:new Date().toISOString(),urlType:cr[0].urlType},...p].slice(0,20));
      addLog(`✓ Done — ${cr.filter(r=>!r.error).length}/${cr.length} pages extracted.`);
    }catch(e){setError(e.message);addLog(`✗ ${e.message}`)}finally{setLoading(false)}
  };

  const selMode=EXTRACTION_MODES.find(m=>m.id===mode);
  const selScope=CRAWL_SCOPES.find(s=>s.id===scope);

  return(
    <div style={{minHeight:"100vh",background:P.base,color:P.white,position:"relative",display:"flex",flexDirection:"column"}}>
      <GrainOverlay/>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
        @keyframes glow{0%,100%{box-shadow:0 0 20px ${P.accentGlow}}50%{box-shadow:0 0 40px ${P.accentGlowStrong}}}
        ::selection{background:${P.accentGlow};color:${P.white}}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${P.faint};border-radius:10px}
        ::-webkit-scrollbar-thumb:hover{background:${P.muted}}
        input::placeholder{color:${P.faint}}
        input[type=range]{-webkit-appearance:none;height:3px;background:${P.elevated};border-radius:4px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;background:${P.accent};border-radius:50%;cursor:pointer;box-shadow:0 0 10px ${P.accentGlow}}
      `}</style>

      <div style={{maxWidth:880,margin:"0 auto",padding:"56px 28px",position:"relative",zIndex:1,flex:1,width:"100%",boxSizing:"border-box"}}>

        {/* ── Header ── */}
        <div style={{marginBottom:48,animation:"fadeUp 0.6s ease",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:16}}>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            {/* Logo SVG */}
            <div style={{position:"relative",width:36,height:36,flexShrink:0}}>
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="34" height="34" rx="8" stroke={P.accent} strokeWidth="1.5" fill="none" opacity="0.3"/>
                <rect x="4" y="4" width="28" height="28" rx="6" fill={P.accent} opacity="0.08"/>
                <path d="M12 13.5C12 13.5 14.5 11 18 11C21.5 11 24 13.5 24 13.5" stroke={P.accent} strokeWidth="1.8" strokeLinecap="round"/>
                <path d="M10 17C10 17 13 14 18 14C23 14 26 17 26 17" stroke={P.accent} strokeWidth="1.8" strokeLinecap="round" opacity="0.6"/>
                <path d="M8 20.5C8 20.5 11.5 17 18 17C24.5 17 28 20.5 28 20.5" stroke={P.accent} strokeWidth="1.8" strokeLinecap="round" opacity="0.3"/>
                <circle cx="18" cy="23" r="2.5" fill={P.accent}/>
                <line x1="18" y1="25.5" x2="18" y2="28" stroke={P.accent} strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              {loading && <div style={{position:"absolute",inset:-2,borderRadius:10,animation:"glow 2s ease infinite"}}/>}
            </div>
            <div>
              <div style={{fontSize:15,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:P.white,fontFamily:"'Syne',sans-serif",lineHeight:1}}>WebScrape</div>
              <div style={{fontSize:11,color:P.muted,fontFamily:"'DM Mono',monospace",marginTop:3}}>Extract <span style={{color:P.accent}}>everything</span> from any page on the web</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:loading?P.accent:P.faint,transition:"all 0.4s",animation:loading?"glow 2s ease infinite":"none"}}/>
            <span style={{fontSize:10,color:loading?P.accent:P.faint,fontFamily:"'DM Mono',monospace",fontWeight:500,letterSpacing:0.5}}>{loading?"Extracting...":"Ready"}</span>
          </div>
        </div>

        {/* ── URL Input ── */}
        <div style={{marginBottom:24,animation:"fadeUp 0.6s ease 0.1s both"}}>
          <div style={{display:"flex",background:P.raised,border:`1px solid ${loading?P.borderActive:P.border}`,borderRadius:14,overflow:"hidden",transition:"border-color 0.3s",boxShadow:loading?`0 0 30px ${P.accentGlow}`:"0 2px 20px rgba(0,0,0,0.2)"}}>
            <input type="text" value={url} onChange={e=>setUrl(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!loading)handleScrape()}}
              placeholder="https://airbnb.com" disabled={loading}
              style={{flex:1,padding:"18px 20px",fontSize:14,background:"transparent",border:"none",outline:"none",color:P.white,fontFamily:"'DM Mono',monospace",letterSpacing:0.3}}/>
            {loading?(
              <button onClick={()=>{abort.current=true}} style={{padding:"18px 24px",fontSize:11,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",background:"transparent",color:P.error,border:"none",borderLeft:`1px solid ${P.border}`,cursor:"pointer",fontFamily:"'DM Mono',monospace",transition:"all 0.2s"}}>Stop</button>
            ):(
              <button onClick={handleScrape} disabled={!url.trim()} style={{padding:"18px 28px",fontSize:11,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",background:url.trim()?`linear-gradient(135deg, ${P.accentDim}, ${P.accent})`:"transparent",color:url.trim()?P.base:P.faint,border:"none",borderLeft:`1px solid ${P.border}`,cursor:url.trim()?"pointer":"default",fontFamily:"'DM Mono',monospace",transition:"all 0.3s"}}>Extract</button>
            )}
          </div>
          {url&&!loading&&(
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10,paddingLeft:4}}>
              <TypeBadge type={detectUrlType(url)}/><span style={{fontSize:11,color:P.faint,fontFamily:"'DM Mono',monospace"}}>{getDomain(url.startsWith("http")?url:"https://"+url)}</span>
            </div>
          )}
        </div>

        {/* ── Controls Row ── */}
        <div style={{display:"flex",gap:16,marginBottom:32,animation:"fadeUp 0.6s ease 0.2s both",flexWrap:"wrap"}}>

          {/* Scope Selector */}
          <div style={{flex:1,minWidth:260}}>
            <button onClick={()=>setShowScope(!showScope)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 0",fontSize:12,background:"none",border:"none",cursor:"pointer",color:P.muted,fontFamily:"'DM Mono',monospace",width:"100%"}}>
              <span style={{fontSize:8,transition:"transform 0.2s",transform:showScope?"rotate(90deg)":"none"}}>▶</span>
              <span>Scope</span>
              <span style={{color:scope!=="single"?P.accent:P.cream,fontWeight:600,marginLeft:4}}>{selScope?.label}</span>
              {scope!=="single"&&<span style={{fontSize:10,color:P.faint,marginLeft:"auto"}}>max {maxPages}</span>}
            </button>
            {showScope&&(
              <div style={{animation:"fadeUp 0.2s ease"}}>
                <div style={{display:"grid",gap:6,marginTop:6}}>
                  {CRAWL_SCOPES.map(s=>(
                    <button key={s.id} onClick={()=>setScope(s.id)} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",textAlign:"left",background:scope===s.id?P.accentGlow:P.raised,border:`1px solid ${scope===s.id?P.borderActive:P.border}`,borderRadius:10,cursor:"pointer",transition:"all 0.2s"}}
                      onMouseEnter={e=>{if(scope!==s.id)e.currentTarget.style.borderColor=P.borderHover}}onMouseLeave={e=>{if(scope!==s.id)e.currentTarget.style.borderColor=P.border}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:scope===s.id?P.accent:P.faint,transition:"all 0.2s",boxShadow:scope===s.id?`0 0 8px ${P.accentGlow}`:"none"}}/>
                      <div><div style={{fontSize:12,fontWeight:600,color:scope===s.id?P.white:P.cream,fontFamily:"'DM Mono',monospace"}}>{s.label}</div><div style={{fontSize:11,color:P.muted,marginTop:2}}>{s.desc}</div></div>
                      <span style={{fontSize:10,color:P.faint,fontFamily:"'DM Mono',monospace",marginLeft:"auto"}}>{s.depth}</span>
                    </button>
                  ))}
                </div>
                {scope!=="single"&&(
                  <div style={{marginTop:10,padding:"12px 16px",background:P.raised,borderRadius:10,border:`1px solid ${P.border}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                      <span style={{fontSize:11,color:P.muted}}>Max pages</span>
                      <span style={{fontSize:14,fontWeight:600,color:P.accent,fontFamily:"'DM Mono',monospace"}}>{maxPages}</span>
                    </div>
                    <input type="range" min={2} max={50} value={maxPages} onChange={e=>setMaxPages(Number(e.target.value))} style={{width:"100%"}}/>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mode Selector */}
          <div style={{flex:1,minWidth:260}}>
            <button onClick={()=>setShowModes(!showModes)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 0",fontSize:12,background:"none",border:"none",cursor:"pointer",color:P.muted,fontFamily:"'DM Mono',monospace",width:"100%"}}>
              <span style={{fontSize:8,transition:"transform 0.2s",transform:showModes?"rotate(90deg)":"none"}}>▶</span>
              <span>Mode</span>
              <span style={{color:P.cream,fontWeight:600,marginLeft:4}}>{selMode?.label}</span>
            </button>
            {showModes&&(
              <div style={{display:"grid",gap:6,marginTop:6,animation:"fadeUp 0.2s ease"}}>
                {EXTRACTION_MODES.map(m=>(
                  <button key={m.id} onClick={()=>{setMode(m.id);setShowModes(false)}} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",textAlign:"left",background:mode===m.id?P.accentGlow:P.raised,border:`1px solid ${mode===m.id?P.borderActive:P.border}`,borderRadius:10,cursor:"pointer",transition:"all 0.2s"}}
                    onMouseEnter={e=>{if(mode!==m.id)e.currentTarget.style.borderColor=P.borderHover}}onMouseLeave={e=>{if(mode!==m.id)e.currentTarget.style.borderColor=P.border}}>
                    <span style={{fontSize:16,color:mode===m.id?P.accent:P.faint,width:22,textAlign:"center"}}>{m.icon}</span>
                    <div><div style={{fontSize:12,fontWeight:600,color:mode===m.id?P.white:P.cream,fontFamily:"'DM Mono',monospace"}}>{m.label}</div><div style={{fontSize:11,color:P.muted,marginTop:2}}>{m.desc}</div></div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Error ── */}
        {error&&<div style={{padding:"12px 18px",marginBottom:24,background:P.errorDim,border:`1px solid ${P.errorBorder}`,borderRadius:10,fontSize:12,color:P.error,fontFamily:"'DM Mono',monospace",animation:"fadeUp 0.2s ease"}}>{error}</div>}

        {/* ── Crawl Progress ── */}
        {loading&&scope!=="single"&&crawlProg.total>0&&<CrawlBar current={crawlProg.current} total={crawlProg.total} pages={crawlProg.pages}/>}

        {/* ── Log ── */}
        {logs.length>0&&(
          <div style={{marginBottom:28,animation:"fadeUp 0.3s ease"}}>
            <div style={{fontSize:10,color:P.faint,marginBottom:6,fontWeight:600,letterSpacing:1.5,textTransform:"uppercase",fontFamily:"'DM Mono',monospace"}}>Log</div>
            <ProgressLog logs={logs}/>
          </div>
        )}

        {/* ── Results ── */}
        {results.length>0&&!loading&&(
          <div style={{animation:"fadeUp 0.4s ease"}}>
            <div style={{marginBottom:20,paddingBottom:20,borderBottom:`1px solid ${P.border}`}}>
              <div style={{fontSize:10,color:P.faint,fontWeight:600,letterSpacing:1.5,textTransform:"uppercase",fontFamily:"'DM Mono',monospace",marginBottom:10}}>Results</div>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <TypeBadge type={results[0].urlType}/>
                <span style={{fontSize:12,color:P.muted,fontFamily:"'DM Mono',monospace"}}>{getDomain(results[0].url)}</span>
                <span style={{width:1,height:12,background:P.border}}/>
                <span style={{fontSize:12,color:P.success,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{results.filter(r=>!r.error).length} ok</span>
                {results.some(r=>r.error)&&<span style={{fontSize:12,color:P.error,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{results.filter(r=>r.error).length} failed</span>}
                <span style={{width:1,height:12,background:P.border}}/>
                <span style={{fontSize:11,color:P.faint,fontFamily:"'DM Mono',monospace"}}>{results.reduce((s,r)=>s+(r.tokenUsage?r.tokenUsage.input_tokens+r.tokenUsage.output_tokens:0),0).toLocaleString()} tokens</span>
              </div>
            </div>

            <div style={{marginBottom:24}}>
              <div style={{fontSize:10,color:P.faint,marginBottom:8,fontWeight:600,letterSpacing:1.5,textTransform:"uppercase",fontFamily:"'DM Mono',monospace"}}>Export{results.length>1?` all ${results.length}`:""}</div>
              <ExportPanel results={results}/>
            </div>

            <div style={{background:P.raised,borderRadius:14,border:`1px solid ${P.border}`,padding:"20px 24px",boxShadow:"0 4px 30px rgba(0,0,0,0.15)"}}>
              <ResultViewer results={results} isSingle={results.length===1}/>
            </div>
          </div>
        )}

        {/* ── History ── */}
        {history.length>0&&!loading&&(
          <div style={{marginTop:56}}>
            <div style={{fontSize:10,color:P.faint,marginBottom:12,fontWeight:600,letterSpacing:1.5,textTransform:"uppercase",fontFamily:"'DM Mono',monospace"}}>Recent</div>
            {history.map((h,i)=>(
              <button key={i} onClick={()=>{setUrl(h.url);if(h.scope)setScope(h.scope)}} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",width:"100%",textAlign:"left",background:"transparent",border:`1px solid transparent`,borderRadius:8,cursor:"pointer",transition:"all 0.2s",marginBottom:2}}
                onMouseEnter={e=>{e.currentTarget.style.background=P.raised;e.currentTarget.style.borderColor=P.border}}onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent"}}>
                <TypeBadge type={h.urlType}/>
                <span style={{fontSize:12,color:P.cream,fontFamily:"'DM Mono',monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{h.url}</span>
                {h.pageCount>1&&<span style={{fontSize:10,color:P.accent,fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{h.pageCount}pg</span>}
                <span style={{fontSize:10,color:P.faint,fontFamily:"'DM Mono',monospace"}}>{new Date(h.timestamp).toLocaleTimeString()}</span>
              </button>
            ))}
          </div>
        )}

      </div>

      {/* ── Footer ── */}
      <div style={{padding:"24px 28px",borderTop:`1px solid ${P.border}`,textAlign:"center",fontFamily:"'DM Mono',monospace",position:"relative",zIndex:1}}>
        <div style={{fontSize:10,color:P.faint,letterSpacing:1,lineHeight:2}}>
          WebScrape · Powered by Anthropic<br/>
          <span style={{color:P.muted}}>Single page · Connected pages · Deep crawl</span>
        </div>
      </div>
    </div>
  );
}
