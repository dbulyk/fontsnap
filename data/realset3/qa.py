import csv,re,difflib,json
from rapidocr_onnxruntime import RapidOCR
ocr=RapidOCR()
cjk=lambda s:re.findall(r"[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]",s)
lat=lambda s:re.sub(r"[^a-z0-9]","",s.lower())
def check(r):
    res,_=ocr("images/"+r["image"]); txt=" ".join(x[1] for x in (res or []))
    exp=r["text"]; sc=r["script"]
    if sc in ("latin","han","kana"):
        a=lat(exp)+"".join(cjk(exp)); b=lat(txt)+"".join(cjk(txt))
        if not b: return 0.0,txt
        m=difflib.SequenceMatcher(None,a,b); 
        # fraction of the expected text found (crop may be cut) and of OCR text explained
        match=sum(x.size for x in m.get_matching_blocks()); return round(min(match/max(1,len(a)), match/max(1,len(b))*1.5,1.0),2),txt
    # cyrillic/arabic/devanagari/hangul: OCR can't read; flag only foreign readable content
    if sc!="hangul" and len(cjk(txt))>=2: return 0.0,txt
    if sc=="hangul": return (1.0 if len(re.findall(r"[\uac00-\ud7af]",txt))>0 or not txt else 0.5),txt
    return (0.5 if len(lat(txt))>12 and lat(txt) not in lat(exp) else 1.0),txt
for fn in ["labels.csv","labels_nongf.csv"]:
    rows=list(csv.DictReader(open(fn))); out=[]
    for r in rows:
        s,t=check(r); r["qa_score"]=s; r["ocr"]=t[:60]; out.append(r)
    json.dump(out,open(fn.replace(".csv","_qa.json"),"w"),ensure_ascii=False)
    import collections; print(fn,collections.Counter("ok" if r["qa_score"]>=0.6 else "weak" if r["qa_score"]>=0.3 else "bad" for r in out))
