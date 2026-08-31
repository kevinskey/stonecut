#!/usr/bin/env python3
"""Fetch CC0/public-domain SVGs from Wikimedia Commons for StoneCut templates.

Sources per app category are a mix of curated Commons categories ("cat") and
full-text searches ("q"). Only PD/CC0-licensed files are kept. SVGs are
normalized (width/height ensured) and a manifest index.json is written.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

OUT = "/Users/kevinjohnson/src/stonecut/public/templates"
API = "https://commons.wikimedia.org/w/api.php"
UA = {"User-Agent": "StoneCutTemplates/1.0 (kpj64110@gmail.com) python-urllib"}
OK_LICENSE = re.compile(r"^(cc0|public domain|pd)", re.I)
_last_call = [0.0]

CATEGORIES = {
    "spirit-wear": {
        "label": "Spirit Wear", "target": 32,
        "sources": [("q", "paw print"), ("q", "eagle silhouette"), ("q", "eagle head"), ("q", "bulldog silhouette"), ("q", "tiger head"), ("q", "lion head silhouette"), ("q", "panther silhouette"), ("q", "wolf silhouette"), ("q", "wolf head"), ("q", "crown icon"), ("q", "royal crown silhouette"), ("q", "megaphone"), ("q", "lightning bolt"), ("q", "ram head"), ("q", "mustang silhouette"), ("q", "shield blank icon"), ("q", "torch icon"), ("q", "star badge")],
    },
    "sports": {
        "label": "Sports", "target": 42,
        "sources": [("q", "basketball icon"), ("q", "basketball player silhouette"), ("q", "american football ball"), ("q", "football player silhouette"), ("q", "baseball icon"), ("q", "baseball player silhouette"), ("q", "baseball bat"), ("q", "soccer ball icon"), ("q", "soccer player silhouette"), ("q", "volleyball icon"), ("q", "volleyball player"), ("q", "tennis ball icon"), ("q", "tennis player silhouette"), ("q", "golf icon"), ("q", "golfer silhouette"), ("q", "trophy icon"), ("q", "runner silhouette"), ("q", "running icon"), ("q", "swimmer silhouette"), ("q", "gymnast silhouette"), ("q", "cyclist silhouette"), ("q", "boxer silhouette"), ("q", "bowling icon"), ("q", "whistle icon"), ("q", "medal icon"), ("q", "softball icon"), ("q", "hockey stick"), ("q", "cheerleading megaphone")],
    },
    "music": {
        "label": "Music", "target": 38,
        "sources": [("q", "musical note icon"), ("q", "eighth note"), ("q", "quarter note"), ("q", "beamed notes"), ("q", "treble clef"), ("q", "bass clef"), ("q", "guitar silhouette"), ("q", "electric guitar"), ("q", "acoustic guitar icon"), ("q", "grand piano silhouette"), ("q", "piano keys icon"), ("q", "saxophone silhouette"), ("q", "trumpet silhouette"), ("q", "violin silhouette"), ("q", "microphone icon"), ("q", "headphones icon"), ("q", "drum icon"), ("q", "drum set silhouette"), ("q", "singer silhouette"), ("q", "music staff"), ("q", "harp silhouette"), ("q", "clarinet"), ("q", "music note svg"), ("q", "sixteenth note"), ("q", "whole note"), ("q", "sharp sign music"), ("q", "banjo svg"), ("q", "cello silhouette"), ("q", "flute svg"), ("q", "french horn"), ("q", "tuba svg"), ("q", "accordion svg"), ("q", "lyre svg")],
    },
    "cheer-dance": {
        "label": "Cheer & Dance", "target": 22,
        "sources": [("q", "cheerleader silhouette"), ("q", "cheerleader"), ("q", "dancer silhouette"), ("q", "ballet dancer silhouette"), ("q", "ballerina silhouette"), ("q", "ballet pose"), ("q", "breakdancer silhouette"), ("q", "dancing couple silhouette"), ("q", "dancer jump silhouette"), ("q", "salsa dancer"), ("q", "tap dance"), ("q", "pointe shoes"), ("q", "dancing silhouette"), ("q", "dance icon"), ("q", "woman dancing svg"), ("q", "man dancing svg"), ("q", "ice skater silhouette"), ("q", "figure skater silhouette"), ("q", "gymnastics silhouette"), ("q", "yoga pose silhouette"), ("q", "flamenco dancer"), ("q", "disco dancer"), ("q", "twirler baton")],
    },
    "hearts-stars": {
        "label": "Hearts & Stars", "target": 30,
        "sources": [("q", "heart icon"), ("q", "heart symbol"), ("q", "heart outline"), ("q", "double heart"), ("q", "heart with wings"), ("q", "star icon"), ("q", "five pointed star"), ("q", "star outline"), ("q", "shooting star"), ("q", "sparkle icon"), ("q", "stars group icon"), ("q", "valentine heart svg"), ("q", "love heart svg"), ("q", "nautical star"), ("q", "star svg icon"), ("q", "heart curve svg"), ("q", "broken heart svg")],
    },
    "animals": {
        "label": "Animals", "target": 30,
        "sources": [("q", "butterfly icon"), ("q", "butterfly silhouette"), ("q", "bird silhouette"), ("q", "bird flying silhouette"), ("q", "cat silhouette"), ("q", "dog silhouette"), ("q", "horse silhouette"), ("q", "horse rearing"), ("q", "dolphin silhouette"), ("q", "deer silhouette"), ("q", "owl silhouette"), ("q", "hummingbird silhouette"), ("q", "dragonfly silhouette"), ("q", "elephant silhouette"), ("q", "turtle silhouette"), ("q", "fish silhouette"), ("q", "unicorn silhouette"), ("q", "swan silhouette"), ("q", "bear silhouette"), ("q", "rabbit silhouette"), ("q", "frog silhouette"), ("q", "penguin silhouette"), ("q", "flamingo silhouette"), ("q", "shark silhouette"), ("q", "bee svg icon"), ("q", "ladybug svg"), ("q", "seahorse silhouette"), ("q", "starfish svg"), ("q", "snake silhouette"), ("q", "rooster silhouette"), ("q", "duck silhouette"), ("q", "squirrel silhouette"), ("q", "fox silhouette"), ("q", "whale silhouette"), ("q", "octopus silhouette")],
    },
    "faith": {
        "label": "Faith & Inspiration", "target": 20,
        "sources": [("q", "latin cross"), ("q", "cross icon"), ("q", "christian cross svg"), ("q", "dove silhouette"), ("q", "dove peace"), ("q", "angel silhouette"), ("q", "praying hands"), ("q", "angel wings"), ("q", "faith hope love"), ("q", "bible icon")],
    },
    "holidays": {
        "label": "Holidays & Seasons", "target": 22,
        "sources": [("q", "snowflake icon"), ("q", "snowflake svg"), ("q", "christmas tree icon"), ("q", "christmas tree silhouette"), ("q", "pumpkin icon"), ("q", "jack o lantern"), ("q", "shamrock"), ("q", "four leaf clover"), ("q", "candy cane"), ("q", "reindeer silhouette"), ("q", "bat silhouette"), ("q", "ghost icon"), ("q", "gift box icon"), ("q", "firework icon"), ("q", "easter egg"), ("q", "santa hat"), ("q", "holly svg"), ("q", "christmas bell svg"), ("q", "christmas ornament svg"), ("q", "wreath svg"), ("q", "snowman svg"), ("q", "witch hat svg"), ("q", "spider web svg"), ("q", "turkey silhouette"), ("q", "halloween pumpkin svg"), ("q", "menorah svg"), ("q", "dreidel svg"), ("q", "firecracker svg"), ("q", "birthday cake svg"), ("q", "balloon svg"), ("q", "party hat svg"), ("q", "witch broom"), ("q", "skull svg icon"), ("q", "candle svg"), ("q", "mistletoe")],
    },
    "nature": {
        "label": "Nature & Symbols", "target": 24,
        "sources": [("q", "flower icon"), ("q", "rose silhouette"), ("q", "tulip icon"), ("q", "sunflower icon"), ("q", "sun icon rays"), ("q", "crescent moon"), ("q", "palm tree silhouette"), ("q", "maple leaf"), ("q", "leaf icon"), ("q", "tree silhouette"), ("q", "anchor icon"), ("q", "fleur de lis"), ("q", "snowdrop flower"), ("q", "mountain icon"), ("q", "wave icon"), ("q", "sunburst svg"), ("q", "cloud svg icon"), ("q", "raindrop svg"), ("q", "flame svg icon"), ("q", "feather svg"), ("q", "seashell svg"), ("q", "cactus svg"), ("q", "pine tree svg"), ("q", "oak leaf svg"), ("q", "lotus svg"), ("q", "butterfly flower svg"), ("q", "moon stars svg"), ("q", "rainbow svg"), ("q", "tornado svg"), ("q", "lightning svg"), ("q", "snow crystal"), ("q", "ivy vine svg"), ("q", "wheat svg"), ("q", "acorn svg")],
    },
}

BAD_TITLE = re.compile(
    r"logo|wordmark|signature|escudo|\bcoa\b|coat of arms|roundel|\bseal\b|flag|banner|"
    r"\bclub\b|mickey|minnie|disney|gun|rifle|ak-?47|pistol|swastika|diagram|chart|"
    r"amun|ba-pef|banebdjedet|hieroglyph|deity|deities|khnum|carillon|mnemonic|"
    r"world cup|mundial|\bghs\b|transducer|crossword|squadron|anarchist|"
    r"speech balloon|hashtag|traffic|\bstub\b|current event|\brange\b|"
    r"federation|association|athletic club|tengrism|moism|\bmaat\b|"
    r"star of david|star and crescent|templar|heraldry|heraldic|1[89][0-9][0-9]", re.I)

def api(params):
    params = dict(params, format="json")
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        wait = _last_call[0] + 0.35 - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            code = getattr(e, "code", None)
            if attempt == 3:
                print(f"  API fail: {e} {url[:110]}", file=sys.stderr)
                return {}
            time.sleep(5 if code == 429 else 2)

def parse_pages(d):
    pages = (d.get("query") or {}).get("pages") or {}
    out = []
    for p in pages.values():
        ii = (p.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata") or {}
        out.append({
            "title": p.get("title", ""),
            "url": ii.get("url", ""),
            "size": ii.get("size", 0),
            "license": (meta.get("LicenseShortName") or {}).get("value", ""),
            "index": p.get("index", 999),
        })
    out.sort(key=lambda x: x["index"])
    return out

IIPROPS = {"prop": "imageinfo", "iiprop": "url|size|extmetadata",
           "iiextmetadatafilter": "LicenseShortName"}

def search_files(query, limit=100):
    return parse_pages(api({"action": "query", "generator": "search",
        "gsrsearch": f"{query} filemime:image/svg+xml",
        "gsrnamespace": "6", "gsrlimit": str(limit), **IIPROPS}))

def category_files(cat, limit=60):
    return parse_pages(api({"action": "query", "generator": "categorymembers",
        "gcmtitle": f"Category:{cat}", "gcmtype": "file",
        "gcmlimit": str(limit), **IIPROPS}))

def slugify(title):
    name = re.sub(r"^File:", "", title)
    name = re.sub(r"\.svg$", "", name, flags=re.I)
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    return name, slug

def normalize_svg(text):
    if "<script" in text.lower() or "<image" in text.lower():
        return None
    if not re.search(r"<(path|polygon|circle|ellipse|rect|polyline)\b", text):
        return None
    root = re.search(r"<svg\b[^>]*>", text)
    if not root:
        return None
    tag = root.group(0)
    if not re.search(r"\bwidth\s*=", tag):
        vb = re.search(r'viewBox\s*=\s*["\']([\d.\s,eE+-]+)["\']', tag)
        if not vb:
            return None
        parts = re.split(r"[\s,]+", vb.group(1).strip())
        if len(parts) != 4:
            return None
        w, h = float(parts[2]), float(parts[3])
        if w <= 0 or h <= 0:
            return None
        text = text.replace(tag, tag[:-1] + f' width="{w}" height="{h}">', 1)
    return text

def grab(files, cat_state, per_source_cap):
    slug, catdir, items, used_slugs, seen_urls, target = cat_state
    n = 0
    for f in files:
        if len(items) >= target or n >= per_source_cap:
            break
        if not f["url"] or not f["url"].split("?")[0].lower().endswith(".svg"):
            continue
        if f["url"] in seen_urls:
            continue
        if not OK_LICENSE.search(f["license"] or ""):
            continue
        if BAD_TITLE.search(f["title"]) or f["size"] > 300_000:
            continue
        name, fslug = slugify(f["title"])
        if fslug in used_slugs:
            continue
        try:
            req = urllib.request.Request(f["url"], headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                text = r.read().decode("utf-8", "replace")
        except Exception:
            continue
        norm = normalize_svg(text)
        if not norm:
            continue
        with open(os.path.join(catdir, fslug + ".svg"), "w") as fh:
            fh.write(norm)
        seen_urls.add(f["url"])
        used_slugs.add(fslug)
        items.append({"name": name, "file": f"{slug}/{fslug}.svg",
                      "license": f["license"],
                      "source": "https://commons.wikimedia.org/wiki/" +
                                urllib.parse.quote(f["title"].replace(" ", "_"))})
        n += 1
        time.sleep(0.1)

def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {"categories": []}
    seen_urls = set()
    total = 0
    for slug, cat in CATEGORIES.items():
        catdir = os.path.join(OUT, slug)
        os.makedirs(catdir, exist_ok=True)
        items, used_slugs = [], set()
        state = (slug, catdir, items, used_slugs, seen_urls, cat["target"])
        for kind, src in cat["sources"]:
            if len(items) >= cat["target"]:
                break
            files = category_files(src) if kind == "cat" else search_files(src)
            grab(files, state, per_source_cap=25)
            print(f"{slug}: {len(items)}/{cat['target']} after {kind}:{src}")
        manifest["categories"].append({"slug": slug, "label": cat["label"], "items": items})
        total += len(items)
    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"TOTAL: {total}")

if __name__ == "__main__":
    main()
