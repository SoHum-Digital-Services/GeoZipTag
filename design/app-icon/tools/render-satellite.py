# Wraps the NASA Blue Marble texture onto an orthographic sphere matching the vector
# globe (same centre and zoom), colour-graded brighter for the icon.
import sys, json, numpy as np
from PIL import Image
tex_path, vec_path, out, size = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
GLASS, ZOOM = 14.9, 1.2
lon0, lat0 = json.load(open(vec_path))['centre']
tex = np.asarray(Image.open(tex_path).convert('RGB'), dtype=np.float32) / 255
H, W = tex.shape[:2]
# Output covers the glass square; each pixel -> view-plane coords in sphere radii.
g = (np.arange(size) + .5) / size * 2 - 1            # -1..1 across the glass
X, Yd = np.meshgrid(g, g); X = X / ZOOM; Y = -Yd / ZOOM
rho2 = X ** 2 + Y ** 2; Z = np.sqrt(np.clip(1 - rho2, 0, 1))
p0, l0 = np.radians(lat0), np.radians(lon0)
lat = np.arcsin(np.clip(Z * np.sin(p0) + Y * np.cos(p0), -1, 1))
lon = l0 + np.arctan2(X, Z * np.cos(p0) - Y * np.sin(p0))
u = ((np.degrees(lon) + 180) % 360) / 360 * W - .5; v = (90 - np.degrees(lat)) / 180 * H - .5
u0 = np.floor(u).astype(int); v0 = np.clip(np.floor(v).astype(int), 0, H - 2); fu = (u - u0)[..., None]; fv = (v - v0)[..., None]
u0 %= W; u1 = (u0 + 1) % W
img = (tex[v0, u0] * (1 - fu) * (1 - fv) + tex[v0, u1] * fu * (1 - fv) + tex[v0 + 1, u0] * (1 - fu) * fv + tex[v0 + 1, u1] * fu * fv)
# Colour grade: lift the dark oceans, keep land natural, add a little saturation.
lum = img.mean(axis=2, keepdims=True)
img = 1 - (1 - img) ** 1.55                                   # brighten shadows/mid-tones
img = lum + (img.mean(axis=2, keepdims=True) - lum) + (img - img.mean(axis=2, keepdims=True)) * 1.18
blue = np.array([0.13, 0.42, 0.88]); oceanish = np.clip((img[..., 2:3] - img[..., 0:1] - .08) * 3, 0, 1)
img = img * (1 - .25 * oceanish) + blue * .25 * oceanish      # nudge oceans toward the icon's blue
img = np.clip(img, 0, 1)
Image.fromarray((img * 255).astype(np.uint8)).save(out, quality=92)
print('rendered', out, size, 'px; centre', lon0, lat0)
