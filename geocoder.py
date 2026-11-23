"""
OpenStreetMap-based geocoder (Photon + Nominatim fallback) with Seoul district validation
and local JSON/SQLite cache support.
"""

import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# Approximate geographic centers for all 25 autonomous districts (자치구) of Seoul
SEOUL_GU_CENTERS = {
    "강남구": (37.5172, 127.0473),
    "강동구": (37.5301, 127.1238),
    "강북구": (37.6396, 127.0257),
    "강서구": (37.5509, 126.8495),
    "관악구": (37.4784, 126.9516),
    "광진구": (37.5385, 127.0823),
    "구로구": (37.4954, 126.8874),
    "금천구": (37.4519, 126.9020),
    "노원구": (37.6542, 127.0568),
    "도봉구": (37.6688, 127.0471),
    "동대문구": (37.5744, 127.0396),
    "동작구": (37.5124, 126.9393),
    "마포구": (37.5663, 126.9016),
    "서대문구": (37.5791, 126.9368),
    "서초구": (37.4837, 127.0324),
    "성동구": (37.5633, 127.0371),
    "성북구": (37.5894, 127.0167),
    "송파구": (37.5145, 127.1059),
    "양천구": (37.5170, 126.8664),
    "영등포구": (37.5264, 126.8962),
    "용산구": (37.5326, 126.9905),
    "은평구": (37.6027, 126.9291),
    "종로구": (37.5730, 126.9794),
    "중구": (37.5641, 126.9979),
    "중랑구": (37.6063, 127.0927),
}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def extract_dong(address: str) -> str:
    m = re.search(r"\(([^,)]+)", address or "")
    if m:
        part = m.group(1).strip()
        # Strip trailing building/apt words if any
        part = part.split()[0]
        if part.endswith(("동", "가", "로")):
            return part
    return ""


def clean_road_address(address: str, gu: str) -> str:
    # Remove parenthetical dong/building notes and floor/unit suffixes
    s = re.sub(r"\([^)]*\)", " ", address or "")
    s = re.sub(r"(?:지하\s*)?\d+\s*층.*$", "", s)
    s = re.sub(r"\d+호.*$", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    # Extract up to road + building number if possible
    m = re.match(r"^(서울(?:특별시)?\s+\S+구\s+\S+(?:로|길)\S*\s+\d+(?:-\d+)?)", s)
    if m:
        return m.group(1)
    if gu and gu not in s:
        return f"서울특별시 {gu} {s}".strip()
    return s


def is_valid_seoul_point(lat: float, lon: float, gu: str) -> bool:
    if not (37.41 <= lat <= 37.71 and 126.76 <= lon <= 127.19):
        return False
    center = SEOUL_GU_CENTERS.get(gu)
    if center and haversine_km(lat, lon, center[0], center[1]) > 10.5:
        return False
    return True


def _query_photon(query: str, gu: str, limit: int = 5):
    center = SEOUL_GU_CENTERS.get(gu, (37.5665, 126.9780))
    url = (
        "https://photon.komoot.io/api/?"
        f"limit={limit}&lat={center[0]}&lon={center[1]}&q="
        + urllib.parse.quote(query)
    )
    req = urllib.request.Request(url, headers={"User-Agent": "ChakhanHankki/1.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    for feat in data.get("features", []):
        coords = feat.get("geometry", {}).get("coordinates")
        if not coords or len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        if is_valid_seoul_point(lat, lon, gu):
            props = feat.get("properties", {})
            # Prefer results whose properties mention the district or dong when possible
            return lat, lon, props
    return None


def _query_nominatim(query: str, gu: str):
    url = (
        "https://nominatim.openstreetmap.org/search?"
        "format=json&limit=3&countrycodes=kr&q=" + urllib.parse.quote(query)
    )
    req = urllib.request.Request(url, headers={"User-Agent": "ChakhanHankki/1.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        items = json.loads(resp.read().decode("utf-8"))
    for item in items:
        lat, lon = float(item["lat"]), float(item["lon"])
        if is_valid_seoul_point(lat, lon, gu):
            return lat, lon
    return None


def deterministic_offset(key: str, radius_deg: float = 0.0022):
    """Small deterministic jitter so fallback district/dong pins do not stack identically."""
    h = abs(hash(key))
    angle = (h % 360) * math.pi / 180.0
    dist = ((h // 360) % 100) / 100.0 * radius_deg
    return math.sin(angle) * dist, math.cos(angle) * dist


_OSM_INDEX_CACHE = None


def _load_osm_index():
    global _OSM_INDEX_CACHE
    if _OSM_INDEX_CACHE is not None:
        return _OSM_INDEX_CACHE
    idx_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "seoul_osm_index.json")
    if os.path.exists(idx_path):
        try:
            with open(idx_path, "r", encoding="utf-8") as f:
                _OSM_INDEX_CACHE = json.load(f)
                return _OSM_INDEX_CACHE
        except Exception:
            pass
    _OSM_INDEX_CACHE = {}
    return _OSM_INDEX_CACHE


def geocode_restaurant(name: str, gu: str, address: str, allow_nominatim: bool = False, allow_remote: bool = True):
    """
    Returns (lat, lng, precision) where precision is one of:
    'osm_road', 'osm_dong', 'poi_or_road', 'dong', 'gu_fallback'
    """
    road = clean_road_address(address, gu)
    dong = extract_dong(address)

    # 0) Fast local OpenStreetMap road/neighborhood index lookup
    idx = _load_osm_index()
    if idx:
        road_m = re.search(r"([가-힣0-9]+(?:대로|로|길)(?:\d+안?길|\d+번?길)?)", address or "")
        road_token = road_m.group(1) if road_m else ""
        gu_center = SEOUL_GU_CENTERS.get(gu, (37.5665, 126.9780))
        if road_token and road_token in idx.get("roads", {}):
            pts = [p for p in idx["roads"][road_token] if is_valid_seoul_point(p[0], p[1], gu)]
            if pts:
                pts.sort(key=lambda pt: haversine_km(pt[0], pt[1], gu_center[0], gu_center[1]))
                top = pts[:3]
                dlat, dlon = deterministic_offset(f"{gu}|{name}|{address}", 0.0008)
                lat = round(sum(p[0] for p in top) / len(top) + dlat, 6)
                lon = round(sum(p[1] for p in top) / len(top) + dlon, 6)
                return lat, lon, "osm_road"
        if dong and dong in idx.get("places", {}):
            pts = [p for p in idx["places"][dong] if is_valid_seoul_point(p[0], p[1], gu)]
            if pts:
                pts.sort(key=lambda pt: haversine_km(pt[0], pt[1], gu_center[0], gu_center[1]))
                dlat, dlon = deterministic_offset(f"{gu}|{name}|{address}", 0.0018)
                return round(pts[0][0] + dlat, 6), round(pts[0][1] + dlon, 6), "osm_dong"

    # 1) Try road address via Photon (only if allow_remote)
    if allow_remote:
        for q in [road, f"{name} {gu} {dong}".strip(), f"서울특별시 {gu} {dong}".strip() if dong else ""]:
            if not q:
                continue
            try:
                res = _query_photon(q, gu, limit=5)
                if res:
                    lat, lon, _ = res
                    prec = "poi_or_road" if q == road or name in q else "dong"
                    if prec == "dong":
                        dlat, dlon = deterministic_offset(f"{name}:{address}", 0.0014)
                        return round(lat + dlat, 6), round(lon + dlon, 6), "dong"
                    return round(lat, 6), round(lon, 6), "poi_or_road"
            except Exception:
                pass

    # 2) Optional Nominatim fallback
    if allow_nominatim:
        try:
            res = _query_nominatim(road, gu)
            if res:
                return round(res[0], 6), round(res[1], 6), "poi_or_road"
        except Exception:
            pass

    # 3) District center fallback with tiny deterministic offset
    base_lat, base_lon = SEOUL_GU_CENTERS.get(gu, (37.5665, 126.9780))
    dlat, dlon = deterministic_offset(f"{name}:{address}", 0.0045)
    return round(base_lat + dlat, 6), round(base_lon + dlon, 6), "gu_fallback"


def batch_geocode_rows(rows, cache_path: str, max_workers: int = 8):
    """Geocode missing addresses in parallel and persist cache_path JSON."""
    cache = {}
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cache = json.load(f)
        except Exception:
            cache = {}

    todo = []
    for r in rows:
        key = f"{r['시군']}|{r['업소명']}|{r['주소']}"
        if key not in cache:
            todo.append((key, r["업소명"], r["시군"], r["주소"]))

    if not todo:
        return cache

    print(f"Geocoding {len(todo)} addresses with {max_workers} workers...")
    done = 0
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {
            ex.submit(geocode_restaurant, name, gu, addr, False): key
            for key, name, gu, addr in todo
        }
        for fut in as_completed(futures):
            key = futures[fut]
            try:
                lat, lon, prec = fut.result()
                cache[key] = {"lat": lat, "lng": lon, "precision": prec}
            except Exception:
                gu = key.split("|", 1)[0]
                base_lat, base_lon = SEOUL_GU_CENTERS.get(gu, (37.5665, 126.9780))
                cache[key] = {"lat": base_lat, "lng": base_lon, "precision": "gu_fallback"}
            done += 1
            if done % 150 == 0 or done == len(todo):
                print(f"  Progress: {done}/{len(todo)}")
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(cache, f, ensure_ascii=False)
    return cache
