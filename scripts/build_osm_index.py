"""
Build a local OpenStreetMap street, neighborhood, and POI coordinate index for Seoul
via Overpass API, then geocode all Seoul restaurants from sheet_snapshot.csv accurately.
"""

import csv
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

from geocoder import SEOUL_GU_CENTERS, deterministic_offset, extract_dong, haversine_km, is_valid_seoul_point

DATA_DIR = os.path.join(BASE_DIR, "data")
SNAPSHOT_PATH = os.path.join(DATA_DIR, "sheet_snapshot.csv")
CACHE_PATH = os.path.join(DATA_DIR, "geocode_cache.json")
INDEX_PATH = os.path.join(DATA_DIR, "seoul_osm_index.json")

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
]
BBOX = "37.413,126.764,37.715,127.184"


def run_overpass(query: str) -> dict:
    last_err = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(
                url,
                data=("data=" + urllib.parse.quote(query)).encode("utf-8"),
                headers={"User-Agent": "ChakhanHankki/1.0"},
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            print(f"  Mirror {url} failed ({exc}), trying next...")
            last_err = exc
    raise last_err


def fetch_osm_index():
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH, "r", encoding="utf-8") as f:
            return json.load(f)

    print("1/3 Fetching Seoul neighborhoods (place) from Overpass API...")
    q_places = f"""
    [out:json][timeout:60];
    (
      node["place"~"suburb|quarter|neighbourhood|town|village"]({BBOX});
      way["place"~"suburb|quarter|neighbourhood"]({BBOX});
    );
    out center;
    """
    places_data = run_overpass(q_places)
    places = defaultdict(list)
    for el in places_data.get("elements", []):
        name = (el.get("tags") or {}).get("name", "").strip()
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if name and lat is not None and lon is not None:
            places[name].append((float(lat), float(lon)))
    print(f"  Loaded {len(places)} place names.")

    print("2/3 Fetching Seoul named roads (highway) from Overpass API...")
    q_roads = f"""
    [out:json][timeout:90];
    way["highway"]["name"]({BBOX});
    out center;
    """
    roads_data = run_overpass(q_roads)
    roads = defaultdict(list)
    for el in roads_data.get("elements", []):
        name = (el.get("tags") or {}).get("name", "").strip()
        center = el.get("center") or {}
        lat, lon = center.get("lat"), center.get("lon")
        if name and lat is not None and lon is not None:
            roads[name].append((float(lat), float(lon)))
    print(f"  Loaded {len(roads)} distinct road names.")

    idx = {"places": dict(places), "roads": dict(roads), "pois": {}}
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False)
    return idx


def _pick_best_for_gu(candidates, gu: str, ref_point=None):
    if not candidates:
        return None
    gu_center = ref_point or SEOUL_GU_CENTERS.get(gu, (37.5665, 126.9780))
    valid = [pt for pt in candidates if is_valid_seoul_point(pt[0], pt[1], gu)]
    if not valid:
        return None
    valid.sort(key=lambda pt: haversine_km(pt[0], pt[1], gu_center[0], gu_center[1]))
    # Average top nearby segments for a central representative point
    top = valid[:3]
    return (
        round(sum(p[0] for p in top) / len(top), 6),
        round(sum(p[1] for p in top) / len(top), 6),
    )


def _extract_road_token(address: str):
    # Extract road name like '자양로13길', '대학로', '올림픽로51길'
    m = re.search(r"([가-힣0-9]+(?:대로|로|길)(?:\d+안?길|\d+번?길)?)", address or "")
    return m.group(1) if m else ""


def geocode_all():
    idx = fetch_osm_index()
    places = idx["places"]
    roads = idx["roads"]
    pois = idx["pois"]

    with open(SNAPSHOT_PATH, "r", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["시도"] == "서울특별시"]

    cache = {}
    stats = Counter()

    for r in rows:
        gu = r["시군"].strip()
        name = r["업소명"].strip()
        addr = r["주소"].strip()
        key = f"{gu}|{name}|{addr}"

        dong = extract_dong(addr)
        dong_pt = None
        if dong:
            dong_pt = _pick_best_for_gu(places.get(dong, []), gu)
            if not dong_pt and dong.endswith("동"):
                # Try matching '홍은1동' etc. for '홍은동'
                stem = dong[:-1]
                for pname, pts in places.items():
                    if pname.startswith(stem) and pname.endswith("동"):
                        dong_pt = _pick_best_for_gu(pts, gu)
                        if dong_pt:
                            break

        norm_name = re.sub(r"\s+", "", name).lower()
        poi_pt = _pick_best_for_gu(pois.get(norm_name, []), gu, dong_pt)

        road_token = _extract_road_token(addr)
        road_pt = _pick_best_for_gu(roads.get(road_token, []), gu, dong_pt) if road_token else None

        if poi_pt:
            lat, lng = poi_pt
            prec = "osm_poi"
        elif road_pt:
            dlat, dlon = deterministic_offset(key, 0.0008)
            lat, lng = round(road_pt[0] + dlat, 6), round(road_pt[1] + dlon, 6)
            prec = "osm_road"
        elif dong_pt:
            dlat, dlon = deterministic_offset(key, 0.0018)
            lat, lng = round(dong_pt[0] + dlat, 6), round(dong_pt[1] + dlon, 6)
            prec = "osm_dong"
        else:
            base_lat, base_lon = SEOUL_GU_CENTERS.get(gu, (37.5665, 126.9780))
            dlat, dlon = deterministic_offset(key, 0.0045)
            lat, lng = round(base_lat + dlat, 6), round(base_lon + dlon, 6)
            prec = "gu_fallback"

        cache[key] = {"lat": lat, "lng": lng, "precision": prec}
        stats[prec] += 1

    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)

    print("Geocoding complete:", len(cache), stats)


if __name__ == "__main__":
    geocode_all()
