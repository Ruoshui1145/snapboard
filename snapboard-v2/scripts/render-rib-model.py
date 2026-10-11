"""Offline orthographic inspection of actual 3MF triangles, no browser/GPU."""
from pathlib import Path
from zipfile import ZipFile
import re
import numpy as np
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parents[1]
with ZipFile(root/'output/sparse-ribs/粗疏筋架-11板样板.3mf') as archive:
    name=next(n for n in archive.namelist() if re.search(r'3D/Objects/object_\d+\.model$',n,re.I))
    xml=archive.read(name).decode()
meshes=[]
for body in re.findall(r'<mesh>(.*?)</mesh>',xml,re.S):
    vertices=np.array(re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"',body),dtype=float)
    triangles=np.array(re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"',body),dtype=int)
    if len(vertices) and len(triangles) and np.ptp(vertices[:,0])>50 and np.ptp(vertices[:,1])>50:
        meshes.append(vertices[triangles]);break
faces=np.concatenate(meshes)
width,height=1280,940
pixels=np.full((height,width,3),[23,31,40],dtype=np.uint8)
depth=np.full((height,width),-np.inf)
elevation,azimuth=np.deg2rad([40,-55])
toward=np.array([np.cos(elevation)*np.cos(azimuth),np.cos(elevation)*np.sin(azimuth),np.sin(elevation)])
right=np.cross([0,0,1],toward);right/=np.linalg.norm(right)
up=np.cross(toward,right)
center=np.array([100,120,2.5])
projected=(faces-center)@np.array([right,-up,toward]).T
projected[:,:,:2]*=13
projected[:,:,0]+=width/2;projected[:,:,1]+=height/2+50
normals=np.cross(faces[:,1]-faces[:,0],faces[:,2]-faces[:,0])
normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-12)
light=np.array([-.35,-.55,.76]);light/=np.linalg.norm(light)
visible=(normals@toward)>0
drawn=0
for face,points,normal in zip(faces[visible],projected[visible],normals[visible]):
    x0=max(24,int(np.floor(points[:,0].min())));x1=min(width-25,int(np.ceil(points[:,0].max())))
    y0=max(110,int(np.floor(points[:,1].min())));y1=min(height-80,int(np.ceil(points[:,1].max())))
    if x0>x1 or y0>y1: continue
    x,y=np.meshgrid(np.arange(x0,x1+1)+.5,np.arange(y0,y1+1)+.5)
    a,b,c=points
    divisor=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
    if abs(divisor)<1e-12:continue
    w0=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/divisor
    w1=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/divisor
    w2=1-w0-w1
    z=w0*a[2]+w1*b[2]+w2*c[2]
    previous=depth[y0:y1+1,x0:x1+1]
    mask=(w0>=-1e-6)&(w1>=-1e-6)&(w2>=-1e-6)&(z>previous)
    if not mask.any():continue
    base=np.array([58,151,138]) if face[:,2].mean()>1.02 else np.array([194,201,207])
    shade=.48+.52*max(0,float(normal@light))
    pixels[y0:y1+1,x0:x1+1][mask]=np.clip(base*shade,0,255).astype(np.uint8)
    previous[mask]=z[mask];drawn+=1
image=Image.fromarray(pixels);draw=ImageDraw.Draw(image)
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',25)
small=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',20)
draw.text((28,22),'实际 3MF 局部：交叉高低筋 · 双侧贯通',font=font,fill='#e9f2f7')
draw.text((28,65),'高筋 4mm  /  矮筋 1.96mm  /  筋根 0.6mm  /  外露边约 0.28mm',font=small,fill='#b8d6cf')
draw.text((28,height-57),'按原始尺寸比例投影；灰色表示保留面，绿色表示骨架。未作承载认证。',font=small,fill='#c5d3dc')
target=root/'output/sparse-ribs/cross-ribs-all-edges.png'
image.save(target)
print(f'{name}: {len(faces)} source triangles, {drawn} visible triangles; {target}')
