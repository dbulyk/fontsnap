import csv,json,pickle,sys,numpy as np
sys.path.insert(0,"/workspace/fontsnap-audit"); sys.argv=["x"]
from exp import prep,sess,probs,crop_normalize,FI,FAMS,nz
from PIL import Image
E="/workspace/fontsnap-eval"; s=sess("/workspace/fontsnap-train/runs/round2/model_fp16.onnx")
rows=list(csv.DictReader(open(f"{E}/realset3/labels.csv"))); P={}
for r in rows:
    im=Image.open(f"{E}/realset3/images/{r['image']}").convert("RGB")
    for v in ["pack","crop"]: P[(r["image"],v)]=probs(s,prep(crop_normalize(im,v))).astype(np.float32)
pickle.dump(P,open("/workspace/fontsnap-ext-work/py_r2h_realset3.pkl","wb"))
