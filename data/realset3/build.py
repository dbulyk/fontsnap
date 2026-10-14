import json,glob,collections,re,csv,random,os
import numpy as np
from PIL import Image
from urllib.parse import urlparse
nz=lambda s:re.sub(r"[^a-z0-9]","",s.lower())
meta={nz(m["family"]):m for m in json.load(open("/workspace/gf_meta.json"))["familyMetadataList"]}
R=[json.loads(l) for f in sorted(glob.glob('raw/*.jsonl')) for l in open(f)]
ex=set()
for s in ["realset","realset2"]:
    for r in csv.DictReader(open(f"../{s}/labels.csv")): ex.add((urlparse(r["url"]).hostname or "").replace("www.",""))
TLD={"ru":"ru","by":"ru","kz":"ru","cn":"zh","tw":"zh","hk":"zh","jp":"ja","kr":"ko","sa":"ar","eg":"ar","ae":"ar","br":"pt","pt":"pt","es":"es","mx":"es","ar":"es","co":"es","fr":"fr","de":"de","id":"id","tr":"tr","vn":"vi"}
SUB={"han":["chinese-simplified","chinese-traditional","chinese-hongkong","japanese"],"kana":["japanese"],"hangul":["korean"],"arabic":["arabic"],"devanagari":["devanagari"],"cyrillic":["cyrillic"],"latin":["latin"]}
def lang(r):
    s=r['script']; hl=(r.get('lang') or '')[:2].lower(); t=urlparse(r['url']).hostname.rsplit('.',1)[-1]
    if s=="han": return "ja" if (hl=="ja" or t=="jp") else "zh"
    m={"kana":"ja","hangul":"ko","arabic":"ar","devanagari":"hi","cyrillic":"ru"}
    if s in m: return m[s]
    txt=r['text'].lower()
    if re.search("[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]",txt): return "vi"
    if re.search("[ğış]",txt): return "tr"
    if re.search("[ãõç]",txt) and t in("br","pt"): return "pt"
    if re.search("[ñ¿¡]",txt): return "es"
    if re.search("[äöüß]",txt) and (hl=="de" or t=="de"): return "de"
    if hl in ("es","pt","fr","de","id","tr","vi"): return hl
    if t in TLD and TLD[t] in("es","pt","fr","de","id","tr","vi") and hl in("",TLD[t]): return TLD[t]
    if hl in("en","") and t not in TLD: return "en"
    return "en" if hl=="en" else "other-latin"
def ok_img(p):
    try: a=np.asarray(Image.open("images/"+p).convert("L"),float); return a.std()>12 and min(a.shape)>=10
    except Exception: return False
rows=[]; dropped=collections.Counter()
for r in R:
    d=(urlparse(r['url']).hostname or "").replace("www.","")
    if d in ex: dropped["domain_overlap"]+=1; continue
    if not os.path.exists("images/"+r["image"]) or not ok_img(r["image"]): dropped["blank"]+=1; continue
    r["language"]=lang(r); r["domain"]=d
    if r["gf"]:
        m=meta.get(nz(r["label"]))
        if not m: dropped["not_in_gf_meta"]+=1; continue
        r["label"]=m["family"]; r["gf_rank"]=m.get("popularity",9999)
        if not any(x in m.get("subsets",[]) for x in SUB[r["script"]]): dropped["font_lacks_script(fallback)"]+=1; continue
    rows.append(r)
g=[r for r in rows if r["gf"]]; n=[r for r in rows if not r["gf"]]
rnd=random.Random(0); rnd.shuffle(g); 
# caps: per family 3 (5 for non-latin since few fonts per script), per language
cap={"en":110,"ru":30}; fam=collections.Counter(); lc=collections.Counter(); sel=[]
g.sort(key=lambda r:(r["script"]=="latin", -r["gf_rank"]))  # non-latin first, then rarer fonts first
for r in g:
    fc=10 if r["script"]!="latin" else (5 if r["language"] not in ("en","other-latin") else 3)
    if fam[r["label"]]>=fc or lc[r["language"]]>=cap.get(r["language"],25): continue
    fam[r["label"]]+=1; lc[r["language"]]+=1; sel.append(r)
# non-GF subset: per label 2, total 70
nl=collections.Counter(); nsel=[]
rnd.shuffle(n)
for r in n:
    k=nz(r["label"])
    if nl[k]>=2 or len(nsel)>=70: continue
    nl[k]+=1; nsel.append(r)
F=["image","label","condition","dpr","script","language","gf_rank","weight","style","size_px","text","tag","url","domain"]
with open("labels.csv","w",newline="") as f:
    w=csv.DictWriter(f,fieldnames=F,extrasaction="ignore"); w.writeheader(); w.writerows(sel)
with open("labels_nongf.csv","w",newline="") as f:
    w=csv.DictWriter(f,fieldnames=["image","label","stack","webfont","condition","dpr","script","language","size_px","text","url","domain"],extrasaction="ignore"); w.writeheader(); w.writerows(nsel)
print("dropped",dict(dropped)); print("main",len(sel),"families",len(fam),"domains",len({r['domain'] for r in sel}),"nongf",len(nsel))
print("lang",dict(lc)); print("script",collections.Counter(r['script'] for r in sel)); print("cond",collections.Counter(r['condition'] for r in sel)); print("dpr",collections.Counter(r['dpr'] for r in sel))
rk=[r['gf_rank'] for r in sel]; print("rank quantiles",np.percentile(rk,[25,50,75,90]).round())
print("nongf top",collections.Counter(r['label'] for r in nsel).most_common(15))
