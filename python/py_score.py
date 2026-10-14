import sys,pickle,csv,json; sys.argv=["x"]
sys.path.insert(0,"/workspace/fontsnap-audit")
src=open("/workspace/fontsnap-audit/r2score.py").read().split("CF=")[0].replace('P=pickle.load(open("p_r2.pkl","rb"))','')
exec(src)
Q=pickle.load(open(sys.argv[1] if len(sys.argv)>1 else "/workspace/fontsnap-ext-work/py_r2h_realset3.pkl","rb"))
P={("r2h","realset3",k[0],k[1]):v for k,v in Q.items()}
for c,(v,a,m) in {"bare":(["pack"],0,False),"best":(["pack","crop"],0.5,True)}.items(): print(c,ev("r2h","realset3",v,a,m)["ALL"])
