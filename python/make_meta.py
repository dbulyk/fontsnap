import sys,json,csv,re; sys.argv=["x"]; sys.path.insert(0,"/workspace/fontsnap-audit")
from exp import FAMS,FI,nz,names
m={r[0]:r[1] for i,r in enumerate(csv.reader(open("/workspace/fontsnap-train/data/google_fonts_mapping_v2b.tsv"),delimiter="\t")) if i}
gf={nz(x["family"]):x for x in json.load(open("/workspace/gf_meta.json"))["familyMetadataList"]}
disp={}
for c in names:
    raw=m.get(c,c.split("-")[0].split("[")[0]); disp.setdefault(nz(raw),raw)
out={"fams":FAMS,"display":[gf[f]["family"] if f in gf else disp.get(f,f) for f in FAMS],
 "inGF":[f in gf for f in FAMS],"category":[gf[f]["category"] if f in gf else "" for f in FAMS],
 "rank":[gf[f].get("popularity",3000) if f in gf else 3000 for f in FAMS],"classFam":FI.tolist(),
 "merge":{"intertight":"inter","ibmplexsanskr":"ibmplexsans","ibmplexsanscondensed":"ibmplexsans","robotoflex":"roboto","robotocondensed":"roboto","opensanscondensed":"opensans","notosansdisplay":"notosans"},
 "keepNoto":["notosanssc","notosanstc","notosanshk","notosansjp","notosanskr","notosansarabic","notosansdevanagari","notosansmono","notosansthai","notosanshebrew"]}
# check rank parity with r2score (pop.get default 3000 & popularity default)
json.dump(out,open("meta.json","w"),separators=(",",":"))
print(len(FAMS),len(FI),sum(out["inGF"]))
