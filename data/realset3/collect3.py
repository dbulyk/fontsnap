"""realset3 collector (held-out, diverse). Like realset2/collect.py, plus: DPR 1/2 per site, Cyrillic tagging,
self-hosted GF aliases (Inter var / InterVariable), and separate non-Google-font cases (system/commercial, tagged gf=0).
python collect3.py --sites chunk.txt --worker 0"""
import argparse, csv, os, random, re, time, json
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser(); p.add_argument("--sites"); p.add_argument("--worker",type=int,default=0); p.add_argument("--max-per-site",type=int,default=3); a=p.parse_args()
norm=lambda s: re.sub(r"[^a-z0-9]","",s.lower())
fams={}
for i,r in enumerate(csv.reader(open("/workspace/fontsnap-train/data/google_fonts_mapping_v2b.tsv"),delimiter="\t")):
    if i: fams.setdefault(norm(r[1]),r[1])
JS=r"""(fams)=>{
 const strip=k=>k.replace(/(variable|var|vf|webfont|web|regular|wght)$/,'');
 const out=[]; const seen=new Set();
 const loaded=new Set([...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family.replace(/["']/g,'').toLowerCase().replace(/[^a-z0-9]/g,'')));
 const els=[...document.querySelectorAll('h1,h2,h3,h4,button,a[class*=btn],a[class*=button],[class*=hero] p,[class*=banner] *,[class*=title],nav a,blockquote,p,li a,label,[class*=price]')];
 for(const el of els){
  const txt=(el.innerText||'').trim(); if(txt.length<3||txt.length>70||txt.includes('\n\n')) continue;
  if(el.children.length>2) continue;
  const r=el.getBoundingClientRect(); if(r.width<40||r.height<11||r.top<0||r.left<0||r.bottom>window.innerHeight||r.right>window.innerWidth) continue;
  const cs=getComputedStyle(el); if(cs.visibility==='hidden'||+cs.opacity<0.5) continue;
  const fam=cs.fontFamily.split(',')[0].replace(/["']/g,'').trim(); let key=fam.toLowerCase().replace(/[^a-z0-9]/g,'');
  let gf=fams.includes(key)?1:(fams.includes(strip(key))?(key=strip(key),1):0);
  const isLoaded=loaded.has(fam.toLowerCase().replace(/[^a-z0-9]/g,''));
  if(gf&&!isLoaded) continue;           // GF name but not actually loaded -> fallback rendering, skip
  if(gf&&!document.fonts.check(`${cs.fontStyle} ${cs.fontWeight} 16px "${fam}"`)) continue;
  let bg=null,img=false,e=el;
  while(e&&e!==document.documentElement){const s=getComputedStyle(e);
    if(s.backgroundImage&&s.backgroundImage!=='none'&&!s.backgroundImage.startsWith('linear')){img=true;break}
    if(s.backgroundImage.startsWith('linear')){bg='gradient';break}
    if(s.backgroundColor&&!/rgba\(.*,\s*0\)|transparent/.test(s.backgroundColor)){bg=s.backgroundColor;break} e=e.parentElement;}
  if(!img){const under=[...document.elementsFromPoint(r.left+r.width/2,r.top+r.height/2)].some(x=>x.tagName==='IMG'||x.tagName==='VIDEO'||x.tagName==='PICTURE'); if(under) img=true;}
  const k=key+cs.fontWeight+cs.fontStyle; if(seen.has(k)) continue; seen.add(k);
  out.push({fam,key,gf,webfont:isLoaded?1:0,stack:cs.fontFamily.slice(0,80),weight:cs.fontWeight,style:cs.fontStyle,size:parseFloat(cs.fontSize),color:cs.color,bg:bg||'rgb(255, 255, 255)',img,text:txt.slice(0,60),x:r.left,y:r.top,w:r.width,h:r.height,tag:el.tagName});
 } return out.map(o=>Object.assign(o,{lang:(document.documentElement.lang||"").slice(0,8)}));}"""
def script(t):
    for name,rx in [("hangul","[\uac00-\ud7af]"),("kana","[\u3040-\u30ff]"),("han","[\u4e00-\u9fff]"),("arabic","[\u0600-\u06ff]"),("devanagari","[\u0900-\u097f]"),("cyrillic","[\u0400-\u04ff]")]:
        if re.search(rx,t): return name
    return "latin"
def lum(c):
    m=re.findall(r"[\d.]+",c); return 0.299*float(m[0])+0.587*float(m[1])+0.114*float(m[2]) if len(m)>=3 else 255
def cond(c):
    if c["size"]<18: return "small-text"
    if c["img"]: return "over-photo"
    if c["bg"]=="gradient": return "colored-bg"
    return "clean" if lum(c["bg"])>225 and lum(c["color"])<110 else "colored-bg"
LOC={"ru":"ru-RU","by":"ru-RU","kz":"ru-RU","cn":"zh-CN","jp":"ja-JP","kr":"ko-KR","in":"hi-IN","sa":"ar-SA","eg":"ar-EG","ae":"ar-AE","br":"pt-BR","pt":"pt-PT","es":"es-ES","mx":"es-MX","ar":"es-AR","co":"es-CO","fr":"fr-FR","de":"de-DE","id":"id-ID","tr":"tr-TR","vn":"vi-VN","tw":"zh-TW","hk":"zh-HK"}
W=a.worker; os.makedirs("raw",exist_ok=True); out=open(f"raw/w{W}.jsonl","a"); log=open(f"raw/w{W}.log","a"); R=random.Random(W)
with sync_playwright() as pw:
    b=pw.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    for si,url in enumerate([l.strip() for l in open(a.sites) if l.strip()]):
        dpr=2 if R.random()<0.4 else 1
        ctx=b.new_context(viewport={"width":1366,"height":900},device_scale_factor=dpr,locale=LOC.get(url.split("/")[2].rsplit(".",1)[-1],"en-US"),
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36 FontSnapResearch")
        pg=ctx.new_page(); pg.set_default_timeout(20000)
        try:
            pg.goto(url,timeout=25000,wait_until="domcontentloaded"); pg.wait_for_timeout(3000)
            pg.evaluate("document.fonts.ready.then(()=>1)")
            cands=pg.evaluate(JS,list(fams.keys())); R.shuffle(cands); cands.sort(key=lambda c:(-c["gf"],-c["size"]))
            used=set(); taken=0; ng=0
            for c in cands:
                if c["key"] in used: continue
                if c["gf"] and taken>=a.max_per_site: continue
                if not c["gf"] and ng>=1: continue
                pad=R.randint(6,28); x0,y0=max(0,c["x"]-pad),max(0,c["y"]-pad)
                clip={"x":x0,"y":y0,"width":min(c["w"]+2*pad,1366-x0),"height":min(c["h"]+2*pad,900-y0)}
                n=f"w{W}_{si:04d}_{len(used)}.png"; pg.screenshot(path="images/"+n,clip=clip)
                out.write(json.dumps({"image":n,"label":fams[c["key"]] if c["gf"] else c["fam"],"gf":c["gf"],"webfont":c["webfont"],"stack":c["stack"],"condition":cond(c),"dpr":dpr,
                    "script":script(c["text"]),"lang":c.get("lang",""),"weight":c["weight"],"style":c["style"],"size_px":c["size"],"text":c["text"],"tag":c["tag"],"url":url})+"\n"); out.flush()
                used.add(c["key"]); taken+=c["gf"]; ng+=1-c["gf"]
            log.write(f"{url}\t{len(cands)}\t{taken}\t{ng}\n")
        except Exception as e: log.write(f"{url}\tERR {str(e)[:80]}\n")
        finally:
            try: ctx.close()
            except Exception: pass
            log.flush()
b.close() if False else None
