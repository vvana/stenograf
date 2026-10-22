"""Общее для скриптов HD-пакета."""
import numpy as np

def depth_view(f):
    """Камера карты глубины кадра: (c2w ARKit 4×4, fx, fy, cx, cy, w, h).
    Если кадр заменён снимком 12 Мп, глубина осталась от видеокадра — у неё своя поза и интринсики
    (depth_transform_matrix / depth_camera); иначе — те же, что у кадра."""
    T = np.array(f.get('depth_transform_matrix', f['transform_matrix']))
    c = f.get('depth_camera', f)
    return T, c['fl_x'], c['fl_y'], c['cx'], c['cy'], c['w'], c['h']
