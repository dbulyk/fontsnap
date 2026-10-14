import csv,json,pickle,collections,numpy as np,sys
sys.argv=["x"]; from exp import FAMS,FI,nz
E="/workspace/fontsnap-eval"
P=pickle.load(open("p_r2.pkl","rb"))
pop={nz(m["family"]):m.get("popularity",3000) for m in json.load(open("/workspace/gf_meta.json"))["familyMetadataList"]}
rank=np.array([pop.get(f,3000) for f in FAMS],float)
MM={"intertight":"inter","ibmplexsanskr":"ibmplexsans","ibmplexsanscondensed":"ibmplexsans","robotoflex":"roboto","robotocondensed":"roboto","opensanscondensed":"opensans","notosansdisplay":"notosans"}
KEEP=("notosanssc","notosanstc","notosanshk","notosansjp","notosanskr","notosansarabic","notosansdevanagari","notosansmono","notosansthai","notosanshebrew")
def mg(f): return "notosans" if f.startswith("notosans") and not f.startswith(KEEP) else MM.get(f,f)
RW={sn:list(csv.DictReader(open(f"{E}/{sn}/labels.csv"))) for sn in ("realset3","realset2","realset")}
def topf(p,a,m):
    fp=np.bincount(FI,weights=p.astype(float),minlength=len(FAMS))
    if a: fp=fp*rank**-a
    t=[FAMS[i] for i in np.argsort(-fp)[:40]]
    if m:
        u=[]
        for x in map(mg,t):
            if x not in u: u.append(x)
        t=u
    return t
def ev(M,sn,v,a,m,key=None,filt=None):
    g=collections.defaultdict(lambda:[0,0,0])
    for r in RW[sn]:
        if filt and not filt(r): continue
        t=topf(np.mean([P[(M,sn,r["image"],x)] for x in v],0),a,m); l=nz(r["label"]); l=mg(l) if m else l
        for k in ["ALL"]+([r[key]] if key else []):
            s=g[k]; s[0]+=1; s[1]+=l==t[0]; s[2]+=l in t[:5]
    return {k:(n,round(100*a1/n,1),round(100*a5/n,1)) for k,(n,a1,a5) in g.items()}
CF={"bare":(["pack"],0,False),"best":(["pack","crop"],0.5,True)}
print("== ALL top1/top5")
for sn in RW:
    for c,(v,a,m) in CF.items():
        o=[ev(M,sn,v,a,m)["ALL"] for M in ("r1b","r2","r2h")]
        print(f"{sn:9s} {c:5s} n={o[0][0]:3d} | r1b {o[0][1]}/{o[0][2]} | r2 {o[1][1]}/{o[1][2]} | r2-fp16 {o[2][1]}/{o[2][2]}")
def br(title,key,filt=None):
    R={(M,c):ev(M,"realset3",*CF[c],key=key,filt=filt) for M in ("r1b","r2") for c in CF}
    print(f"\n== realset3 {title}: n | r1b bare | r2 bare | r1b best | r2 best")
    for k in sorted(R["r1b","bare"],key=lambda k:-R["r1b","bare"][k][0]):
        print(f"  {k:12s} {R['r1b','bare'][k][0]:4d} | "+" | ".join(f"{R[x][k][1]:5}/{R[x][k][2]:<5}" for x in [("r1b","bare"),("r2","bare"),("r1b","best"),("r2","best")]))
br("by script","script"); br("by language","language"); br("by condition","condition")
br("small-text by script","script",lambda r:r["condition"]=="small-text")
br("latin by condition","condition",lambda r:r["script"]=="latin")
# fp16 parity
d=[];agree=0;n=0
for (M,sn,im,v),p in P.items():
    if M!="r2": continue
    q=P[("r2h",sn,im,v)]; d.append(np.abs(p-q).max()); n+=1; agree+=p.argmax()==q.argmax()
print(f"\n== fp16 parity (r2 vs r2-fp16, {n} inputs): top1 class agreement {100*agree/n:.1f}%, max|dp| median {np.median(d):.4f} max {np.max(d):.4f}")
