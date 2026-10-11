import sys
import json,numpy as np
from pathlib import Path
folder=Path(sys.argv[1] if len(sys.argv)>1 else 'output/woodgrain-analysis');raw=(folder/'geometry.bin').read_bytes();nv,nt=np.frombuffer(raw,dtype='<u4',count=2)
v=np.frombuffer(raw,dtype='<f8',count=int(nv)*3,offset=8).reshape(-1,3);t=np.frombuffer(raw,dtype='<u4',count=int(nt)*3,offset=8+int(nv)*24).reshape(-1,3)
lab=np.fromfile(folder/'labels.bin',dtype='<u2');tri=v[t];tl=lab[t[:,0]]
zs=np.arange(-200,126,25);axis=[];slopes=[];coeffs=[];errors=[]
for z in zs:
 active=(tri[:,:,2].min(1)<z)&(tri[:,:,2].max(1)>z);faces=tri[active];labs=tl[active];points=[];pl=[]
 for j in range(3):
  a,b=faces[:,j],faces[:,(j+1)%3];mask=(a[:,2]<z)!=(b[:,2]<z);w=(z-a[mask,2])/(b[mask,2]-a[mask,2]);points.append(a[mask,:2]+w[:,None]*(b[mask,:2]-a[mask,:2]));pl.append(labs[mask])
 q=np.concatenate(points);labels=np.concatenate(pl);centers=[];radii=[];relative=[]
 for c in range(5,51):
  p=q[labels==c];center=(p.min(0)+p.max(0))/2;delta=p-center;r=np.linalg.norm(delta,axis=1);theta=np.arctan2(delta[:,1],delta[:,0]);design=np.column_stack([np.ones(len(p))]+[f(k*theta)for k in range(1,17)for f in [np.cos,np.sin]])
  if r.std()/r.mean()>.04:continue
  fit=np.linalg.lstsq(design,r,rcond=None)[0];centers.append(center);radii.append(fit[0]);relative.append(fit[3:]/fit[0])
 reg=np.linalg.lstsq(np.column_stack([np.ones(len(radii)),radii]),np.array(centers),rcond=None)[0]
 axis.append(reg[0]);slopes.append(reg[1]);coeffs.append(np.mean(relative,axis=0))
z=np.array(zs);basis=np.column_stack([np.ones(len(z))]+[f(2*np.pi*k*z/500)for k in range(1,4)for f in [np.cos,np.sin]])
center=np.linalg.lstsq(basis,np.array(axis),rcond=None)[0]
angular=np.mean(coeffs,axis=0);drift=np.median(slopes,axis=0)
error=np.sqrt(np.mean((basis@center-np.array(axis))**2,axis=0))
profile={'description':'Statistical growth-shell fit from reference cross-sections; no source vertices or triangle indices.','axialPeriodMm':500,'centerX':center[:,0].round(8).tolist(),'centerY':center[:,1].round(8).tolist(),'radialCenterDrift':drift.round(8).tolist(),'angularFirstHarmonic':2,'angular':angular.round(8).tolist(),'centerFitRmsMm':error.round(6).tolist()}
Path('src/assets/woodgrain-growth-profile.json').write_text(json.dumps(profile,indent=2),encoding='utf8')
print(json.dumps(profile,indent=2))
