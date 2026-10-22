#!/bin/bash
# HD-пакет + сетка → сетка с фото-текстурой (OpenMVS). texpkg.sh <пакет> <сетка> <рабочая папка> <выход .glb>
set -e
S=$(cd "$(dirname "$0")" && pwd); B=$S/openmvs/bin/vc17/x64/Release
py -3.9 "$S/to_colmap.py" "$1" "$3" "$2"
cd "$3"; rm -f *.log scene.mvs
"$B/InterfaceCOLMAP.exe" -i . -o scene.mvs --image-folder images > /dev/null 2>&1; grep "Exported data" InterfaceCOLMAP-*.log
"$B/TextureMesh.exe" scene.mvs -m mesh.ply -o t.mvs --export-type obj --global-seam-leveling 0 --local-seam-leveling 0 --max-texture-size 8192 > /dev/null 2>&1
grep -E "best view|atlas|texturing completed" TextureMesh-*.log | sed 's/.*\] //'
py -3.9 -c "
import trimesh,sys
s=trimesh.load('t.obj')
for g in (s.geometry.values() if hasattr(s,'geometry') else [s]):
    im=g.visual.material.image.convert('RGB'); im.format='JPEG'; g.visual.material.image=im
s.export(sys.argv[1])" "$4"
ls -la "$4"
