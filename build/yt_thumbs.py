#!/usr/bin/env python3
"""Make self-hosted WebP thumbnails for content/videos.json (not part of the Netlify build).

Needs Pillow and network access. Run: python3 build/yt_thumbs.py
Writes content/media/yt-<id>-*.webp and lists them in content/media/media.json, so pages show a
thumbnail without any request to YouTube until a visitor taps play.
  long-form: yt-<id>-640.webp + yt-<id>-960.webp (16:9, from maxresdefault)
  Short:     yt-<id>-360.webp (9:16, from oar2)
  grid tile: yt-<id>-4x3.webp (4:3, from hqdefault, same framing as the old i.ytimg tiles)
"""
import io, json, os, urllib.request
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C = os.path.join(ROOT, 'content')
VJ = json.load(open(os.path.join(C, 'videos.json'), encoding='utf-8'))

def get(vid, name):
    try:
        with urllib.request.urlopen(f'https://i.ytimg.com/vi/{vid}/{name}.jpg', timeout=20) as r:
            return Image.open(io.BytesIO(r.read())).convert('RGB')
    except Exception:
        return None

def fit(im, w, h):
    sw, sh = im.size; r = max(w / sw, h / sh)
    im = im.resize((round(sw * r), round(sh * r)), Image.LANCZOS)
    l, t = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((l, t, l + w, t + h))

def save(im, name, alt, out):
    im.save(os.path.join(C, 'media', name), 'WEBP', quality=72, method=6)
    out.append({'file': name, 'alt': alt, 'width': im.width, 'height': im.height})

def main():
    grid = {k for g in VJ['grids'].values() for k in g}
    made = []
    for key, v in VJ['videos'].items():
        vid = v.get('id') or v.get('proposed_id')
        if not vid: continue
        alt = v['alt']
        if v['kind'] == 'long':
            src = get(vid, 'maxresdefault') or get(vid, 'hqdefault')
            for w in (640, 960): save(fit(src, w, w * 9 // 16), f'yt-{vid}-{w}.webp', alt, made)
        else:
            src = get(vid, 'oar2') or get(vid, 'oardefault') or get(vid, 'hqdefault')
            save(fit(src, 360, 640), f'yt-{vid}-360.webp', alt, made)
        if key in grid:
            save(fit(get(vid, 'hqdefault'), 480, 360), f'yt-{vid}-4x3.webp', alt, made)
    mp = os.path.join(C, 'media', 'media.json')
    media = [m for m in json.load(open(mp, encoding='utf-8')) if not m['file'].startswith('yt-')]
    # yt- entries go first so they never touch the end of the list other branches append to.
    json.dump(sorted({m['file']: m for m in made}.values(), key=lambda m: m['file']) + media, open(mp, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(mp, 'a').write('\n') if not open(mp).read().endswith('\n') else None
    print(f'{len(made)} thumbnails')

if __name__ == '__main__':
    main()
