# Tìm ảnh 360° (equirectangular) trên Wikimedia Commons theo tên địa danh.
# Chỉ đọc thông tin mô tả ảnh qua API công khai, không tải file ảnh.
# Lọc: tỉ lệ khung 2:1 (ảnh 360° trọn vẹn), bề ngang đủ lớn, giấy phép cho dùng thương mại.
# Chạy: python tools/find_panos.py  ->  assets/candidates.json và assets/candidates.md
import io, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

sys.stdout.reconfigure(encoding='utf-8')
API = 'https://commons.wikimedia.org/w/api.php'
UA = 'travel-at-home-asset-finder/0.1 (360 panorama license research)'
MIN_W = 4000

# (mã, tên hiển thị, các cụm từ tìm kiếm)
LANDMARKS = [
    ('hn-ho-guom', 'Hồ Gươm, Hà Nội', ['Hoan Kiem Lake', 'Hồ Gươm', 'Hồ Hoàn Kiếm']),
    ('hn-van-mieu', 'Văn Miếu, Hà Nội', ['Temple of Literature Hanoi', 'Văn Miếu']),
    ('hn-pho-co', 'Phố cổ / trung tâm Hà Nội', ['Hanoi', 'Hà Nội']),
    ('ha-long', 'Vịnh Hạ Long', ['Ha Long Bay', 'Hạ Long']),
    ('hoi-an', 'Hội An', ['Hoi An', 'Hội An']),
    ('hue', 'Đại Nội Huế', ['Hue Imperial City', 'Huế']),
    ('da-nang', 'Đà Nẵng / Bà Nà', ['Da Nang', 'Ba Na Hills', 'Đà Nẵng']),
    ('sai-gon', 'TP. Hồ Chí Minh', ['Ho Chi Minh City', 'Saigon', 'Sài Gòn']),
    ('ninh-binh', 'Ninh Bình / Tràng An', ['Ninh Binh', 'Trang An', 'Tam Coc']),
    ('sa-pa', 'Sa Pa / Fansipan', ['Sa Pa', 'Fansipan']),
    ('eiffel', 'Tháp Eiffel, Paris', ['Eiffel Tower', 'Tour Eiffel']),
    ('great-wall', 'Vạn Lý Trường Thành', ['Great Wall of China']),
    ('taj-mahal', 'Taj Mahal', ['Taj Mahal']),
    ('colosseum', 'Đấu trường La Mã', ['Colosseum Rome', 'Colosseo']),
    ('liberty', 'Tượng Nữ thần Tự do', ['Statue of Liberty']),
    ('giza', 'Kim tự tháp Giza', ['Giza pyramids', 'Great Pyramid of Giza']),
    ('sydney-opera', 'Nhà hát Opera Sydney', ['Sydney Opera House']),
    ('fuji', 'Núi Phú Sĩ', ['Mount Fuji']),
    ('machu-picchu', 'Machu Picchu', ['Machu Picchu']),
    ('angkor', 'Angkor Wat', ['Angkor Wat']),
]
OK_LICENSE = re.compile(r'^(cc0|pd|public domain|cc[- ]by(-sa)?([- ][\d.]+)?)', re.I)


def api(params):
    params = dict(params, format='json', formatversion='2')
    req = urllib.request.Request(API + '?' + urllib.parse.urlencode(params), headers={'User-Agent': UA})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            wait = int(e.headers.get('Retry-After') or 0) or 20 * (attempt + 1)   # bị giới hạn tốc độ: chờ rồi thử lại
            print(f'  bị giới hạn tốc độ, chờ {wait} giây')
            time.sleep(min(wait, 120))
    raise RuntimeError('vẫn bị giới hạn tốc độ sau 5 lần thử')


def strip(html):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', html or '')).strip()


def search(q):
    d = api({'action': 'query', 'generator': 'search', 'gsrnamespace': '6', 'gsrlimit': '50', 'gsrsearch': q,
             'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata', 'iiurlwidth': '640',
             'iiextmetadatafilter': 'LicenseShortName|Artist|AttributionRequired|ImageDescription|Credit'})
    return (d.get('query') or {}).get('pages') or []


def main():
    out = []
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
    cache = os.path.join(root, 'candidates.json')
    done = {x['code']: x for x in json.load(io.open(cache, encoding='utf-8'))} if os.path.exists(cache) else {}
    for code, name, terms in LANDMARKS:
        if done.get(code, {}).get('seen'):                  # đã tìm xong ở lần chạy trước
            out.append(done[code]); print(f"{name}: {done[code]['total']} ứng viên (lấy từ lần trước)"); continue
        seen, cands = set(), []
        for t in terms:
            for q in (f'hastemplate:Pano360 {t}', f'{t} equirectangular', f'{t} 360 panorama'):
                try:
                    pages = search(q)
                except Exception as e:                       # lỗi mạng tạm thời: bỏ qua truy vấn này
                    print('  lỗi truy vấn', q, e)
                    pages = []
                time.sleep(1.5)
                for p in pages:
                    ii = (p.get('imageinfo') or [{}])[0]
                    w, h = ii.get('width') or 0, ii.get('height') or 0
                    if p['title'] in seen or not h:
                        continue
                    seen.add(p['title'])
                    if ii.get('mime') not in ('image/jpeg', 'image/png', 'image/tiff') or w < MIN_W or abs(w / h - 2) > 0.03:
                        continue
                    em = ii.get('extmetadata') or {}
                    lic = strip((em.get('LicenseShortName') or {}).get('value'))
                    if not OK_LICENSE.match(lic):
                        continue
                    cands.append({
                        'title': p['title'], 'page': ii.get('descriptionurl'), 'thumb': ii.get('thumburl'), 'file': ii.get('url'),
                        'w': w, 'h': h, 'license': lic, 'author': strip((em.get('Artist') or {}).get('value'))[:80],
                        'attribution_required': (em.get('AttributionRequired') or {}).get('value') == 'true',
                        'desc': strip((em.get('ImageDescription') or {}).get('value'))[:160],
                    })
        cands.sort(key=lambda c: (c['title'].startswith('File:Mapillary'), -c['w']))   # ảnh chụp có chủ đích trước, ảnh đường phố Mapillary sau
        print(f'{name}: {len(cands)} ứng viên (đã xem {len(seen)} ảnh)')
        out.append({'code': code, 'name': name, 'candidates': cands[:8], 'total': len(cands), 'seen': len(seen)})
        os.makedirs(root, exist_ok=True)
        json.dump(out, io.open(cache + '.part', 'w', encoding='utf-8'), ensure_ascii=False)

    os.makedirs(root, exist_ok=True)
    json.dump(out, io.open(os.path.join(root, 'candidates.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    with io.open(os.path.join(root, 'candidates.md'), 'w', encoding='utf-8') as f:
        f.write('# Ứng viên ảnh 360° từ Wikimedia Commons\n\n')
        f.write(f'Lọc: tỉ lệ 2:1, bề ngang từ {MIN_W} điểm, giấy phép CC0 / PD / CC BY / CC BY-SA. '
                'Chưa tải ảnh nào; giấy phép cần được xem lại trên trang của từng ảnh trước khi dùng.\n\n')
        for lm in out:
            f.write(f"## {lm['name']} ({lm['total']} ứng viên)\n\n")
            if not lm['candidates']:
                f.write('Chưa tìm thấy ảnh đạt yêu cầu.\n\n')
                continue
            f.write('| Ảnh | Cỡ | Giấy phép | Tác giả | Mô tả |\n|---|---|---|---|---|\n')
            for c in lm['candidates']:
                t = c['title'].replace('File:', '').replace('|', ' ')
                f.write(f"| [{t[:60]}]({c['page']}) | {c['w']}x{c['h']} | {c['license']} | {c['author'].replace('|', ' ')} | {c['desc'].replace('|', ' ')} |\n")
            f.write('\n')
    print('đã ghi assets/candidates.json và assets/candidates.md')


if __name__ == '__main__':
    main()
