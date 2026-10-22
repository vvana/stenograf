"""Собирает автономный просмотрщик GLB (один html, без интернета): three.js r170 + GLTFLoader + OrbitControls внутри файла.
py -3.9 build_viewer.py <папка package из three-0.170.0.tgz> <выход.html>"""
import sys, os
pkg, out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
def rd(p): return open(os.path.join(pkg, p), encoding='utf-8').read()
parts = {
    '/*THREE*/': rd('build/three.module.min.js'),
    '/*BGU*/': rd('examples/jsm/utils/BufferGeometryUtils.js'),
    '/*GLTF*/': rd('examples/jsm/loaders/GLTFLoader.js').replace("'../utils/BufferGeometryUtils.js'", "'bgu'"),
    '/*ORBIT*/': rd('examples/jsm/controls/OrbitControls.js'),
}
html = open(os.path.join(here, 'viewer_template.html'), encoding='utf-8').read()
for k, v in parts.items():
    assert '</script' not in v.lower(), k
    assert k in html, k
    html = html.replace(k, v)
open(out, 'w', encoding='utf-8').write(html)
print(out, f'{len(html) / 1048576:.1f} MB')
