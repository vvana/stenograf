"""GLB: фото-текстура → emissive, собственный цвет чёрный. Так модель выглядит одинаково в любом просмотрщике:
и в тех, что понимают KHR_materials_unlit, и в тех, что его игнорируют (3dviewer) — освещение на «светящийся» цвет не влияет.
py -3.9 emissive.py <in.glb> <out.glb>"""
import sys, json, struct
src, dst = sys.argv[1], sys.argv[2]
b = open(src, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]; js = json.loads(b[20:20 + jl]); rest = b[20 + jl:]
for mt in js.get('materials', []):
    pr = mt.get('pbrMetallicRoughness', {})
    if 'baseColorTexture' in pr:
        mt['emissiveTexture'] = pr.pop('baseColorTexture'); mt['emissiveFactor'] = [1.0, 1.0, 1.0]
        pr['baseColorFactor'] = [0.0, 0.0, 0.0, 1.0]; pr['metallicFactor'] = 0.0; pr['roughnessFactor'] = 1.0
        mt.get('extensions', {}).pop('KHR_materials_unlit', None)
        if not mt.get('extensions'): mt.pop('extensions', None)
used = any('KHR_materials_unlit' in m.get('extensions', {}) for m in js.get('materials', []))
js['extensionsUsed'] = [e for e in js.get('extensionsUsed', []) if e != 'KHR_materials_unlit' or used]
if not js['extensionsUsed']: js.pop('extensionsUsed')
nj = json.dumps(js, separators=(',', ':')).encode(); nj += b' ' * ((4 - len(nj) % 4) % 4)
open(dst, 'wb').write(b[:4] + struct.pack('<I', 2) + struct.pack('<I', 12 + 8 + len(nj) + len(rest)) + struct.pack('<I', len(nj)) + b'JSON' + nj + rest)
print('ok', len(js.get('materials', [])))
