import csv,json,re,sys,time,os,numpy as np,cv2,yaml,onnxruntime as ort
from PIL import Image
sys.path.insert(0,"/workspace/fontsnap-train"); from textcrop import crop_normalize
T="/workspace/fontsnap-train"; E="/workspace/fontsnap-eval"
names=yaml.safe_load(open(f"{T}/data/classes_v2.yaml"))["classnames"]
nz=lambda s:re.sub(r"[^a-z0-9]","",s.lower())
def fammap(path):
    m={r[0]:r[1] for i,r in enumerate(csv.reader(open(path),delimiter="\t")) if i}; return lambda c: nz(m.get(c,c.split("-")[0].split("[")[0]))
fam=fammap(f"{T}/data/google_fonts_mapping_v2b.tsv")
FAMS=sorted({fam(c) for c in names}); fi={f:i for i,f in enumerate(FAMS)}; FI=np.array([fi[fam(c)] for c in names])
MEAN=np.array([0.485,0.456,0.406],np.float32); STD=np.array([0.229,0.224,0.225],np.float32)
def prep(pil,S=320,bin_=False,inv=False):
    im=np.array(pil.convert("RGB"))[:1024,:1024]
    if bin_:
        g=cv2.cvtColor(im,cv2.COLOR_RGB2GRAY); _,b=cv2.threshold(g,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
        if (b==0).mean()>.5: b=255-b
        im=cv2.cvtColor(b,cv2.COLOR_GRAY2RGB)
    if inv: im=255-im
    h,w=im.shape[:2]; r=S/max(h,w); nw,nh=max(1,int(w*r)),max(1,int(h*r)); im=cv2.resize(im,(nw,nh),interpolation=cv2.INTER_AREA if r<1 else cv2.INTER_LINEAR)
    dw,dh=S-nw,S-nh; im=cv2.copyMakeBorder(im,dh//2,dh-dh//2,dw//2,dw-dw//2,cv2.BORDER_CONSTANT,value=(255,255,255))
    return ((im.astype(np.float32)/255-MEAN)/STD).transpose(2,0,1)[None]
def sess(p):
    so=ort.SessionOptions(); so.intra_op_num_threads=8; return ort.InferenceSession(p,so,providers=["CPUExecutionProvider"])
def probs(s,x):
    lg=s.run(None,{s.get_inputs()[0].name:x.astype(np.float16 if "float16" in s.get_inputs()[0].type else np.float32)})[0][0].astype(np.float64); p=np.exp(lg-lg.max()); return p/p.sum()
VARIANTS={
 "pack":lambda im:[prep(crop_normalize(im,"pack"))],
 "crop":lambda im:[prep(crop_normalize(im,"crop"))],
 "none":lambda im:[prep(im)],
 "pack_lh72":lambda im:[prep(crop_normalize(im,"pack",line_h=72))],
 "pack_lh128":lambda im:[prep(crop_normalize(im,"pack",line_h=128))],
 "pack_bin":lambda im:[prep(crop_normalize(im,"pack"),bin_=True)],
 "pack_maxl3":lambda im:[prep(crop_normalize(im,"pack",max_lines=3))],
}
def run(model,sets,variants,tta=None):
    s=sess(model); res={}; P={}
    for sn in sets:
        rows=list(csv.DictReader(open(f"{E}/{sn}/labels.csv")))
        for r in rows:
            im=Image.open(f"{E}/{sn}/images/{r['image']}").convert("RGB")
            for v in variants:
                t=time.perf_counter(); p=np.mean([probs(s,x) for x in VARIANTS[v](im)],0); P[(sn,r["image"],v)]=(p,time.perf_counter()-t)
    return P
if __name__=="__main__":
    import pickle; model=sys.argv[1]; out=sys.argv[2]; vs=sys.argv[3].split(",")
    P=run(model,["realset2","realset"],vs); pickle.dump({k:(v[0].astype(np.float32),v[1]) for k,v in P.items()},open(out,"wb"))
