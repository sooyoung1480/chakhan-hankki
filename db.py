"""
SQLite database layer and Google Sheets CSV synchronization for Chakhan-Hankki.
"""

import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import sqlite3
import urllib.request
from datetime import datetime, timezone

from geocoder import SEOUL_GU_CENTERS, extract_dong, geocode_restaurant

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CACHE_PATH = os.path.join(DATA_DIR, "geocode_cache.json")
SNAPSHOT_PATH = os.path.join(DATA_DIR, "sheet_snapshot.csv")

GOOGLE_SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1sMiFRC4RwI4xRnZ-RG2zInph6QAV6ywWpS4POHZDoZw/export?format=csv&gid=553501454"
)

ALLOWED_CATEGORIES = {"한식", "중식", "일식", "양식", "베이커리"}

SEOUL_CAMPUS_HUBS = [
    {"id": "sinchon", "name": "신촌역 (연대·서강·이대)", "gu": "서대문구", "lat": 37.5551, "lng": 126.9368},
    {"id": "hongdae", "name": "홍대입구역 (홍익대)", "gu": "마포구", "lat": 37.5572, "lng": 126.9245},
    {"id": "hyehwa", "name": "혜화역 (성균관대)", "gu": "종로구", "lat": 37.5821, "lng": 127.0019},
    {"id": "anam", "name": "안암역 (고려대)", "gu": "성북구", "lat": 37.5863, "lng": 127.0291},
    {"id": "hoegi", "name": "회기역 (경희·외대·시립대)", "gu": "동대문구", "lat": 37.5897, "lng": 127.0579},
    {"id": "kondae", "name": "건대입구역 (건국·세종대)", "gu": "광진구", "lat": 37.5404, "lng": 127.0692},
    {"id": "hanyang", "name": "한양대·왕십리역", "gu": "성동구", "lat": 37.5612, "lng": 127.0378},
    {"id": "snu", "name": "서울대입구역 (서울대)", "gu": "관악구", "lat": 37.4812, "lng": 126.9527},
    {"id": "cau", "name": "흑석역 (중앙대)", "gu": "동작구", "lat": 37.5088, "lng": 126.9637},
    {"id": "soongsil", "name": "숭실대입구역 (숭실대)", "gu": "동작구", "lat": 37.4963, "lng": 126.9537},
    {"id": "sookmyung", "name": "숙대입구역 (숙명여대)", "gu": "용산구", "lat": 37.5446, "lng": 126.9722},
    {"id": "noryangjin", "name": "노량진역", "gu": "동작구", "lat": 37.5134, "lng": 126.9424},
    {"id": "gangnam", "name": "강남·서초권 (교대)", "gu": "서초구", "lat": 37.50564, "lng": 127.01483},
    {"id": "seoul_all", "name": "서울 중심 (시청·종로)", "gu": "중구", "lat": 37.5665, "lng": 126.9780},
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_conn() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS restaurants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            external_key TEXT UNIQUE NOT NULL,
            sido TEXT NOT NULL,
            gu TEXT NOT NULL,
            category TEXT NOT NULL,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            dong TEXT NOT NULL,
            menus_json TEXT NOT NULL,
            min_price INTEGER NOT NULL,
            main_menu TEXT NOT NULL,
            main_price INTEGER NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            geo_precision TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_restaurants_gu ON restaurants(gu);
        CREATE INDEX IF NOT EXISTS idx_restaurants_category ON restaurants(category);
        CREATE INDEX IF NOT EXISTS idx_restaurants_min_price ON restaurants(min_price);

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            nickname TEXT NOT NULL,
            university TEXT DEFAULT '',
            agreed_terms INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            restaurant_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(user_id, restaurant_key)
        );

        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            restaurant_key TEXT NOT NULL,
            restaurant_name TEXT NOT NULL,
            user_id INTEGER,
            report_type TEXT NOT NULL,
            reported_price INTEGER,
            detail TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT '접수됨',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS analytics_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )

    # Seed one demo university student account for immediate presentation/testing
    demo_email = "student@seoul.ac.kr"
    existing = cur.execute("SELECT id FROM users WHERE email = ?", (demo_email,)).fetchone()
    if not existing:
        cur.execute(
            """
            INSERT INTO users (email, password_hash, nickname, university, agreed_terms, created_at)
            VALUES (?, ?, ?, ?, 1, ?)
            """,
            (demo_email, hash_password("demo1234!"), "서울자취생", "서울소재 대학교", utc_now_iso()),
        )
    conn.commit()
    conn.close()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
    return f"{salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, expected_hex = stored.split("$", 1)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
        return hmac.compare_digest(dk.hex(), expected_hex)
    except Exception:
        return False


def _load_geo_cache() -> dict:
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_geo_cache(cache: dict):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def _parse_menus(row: dict):
    menus = []
    for idx in range(1, 5):
        m_name = (row.get(f"메뉴{idx}") or "").strip()
        p_raw = (row.get(f"가격{idx}") or "").strip().replace(",", "")
        if m_name and p_raw.isdigit():
            menus.append({"name": m_name, "price": int(p_raw)})
    return menus


def sync_from_google_sheet(fetch_remote: bool = True) -> dict:
    """
    Fetch latest CSV from Google Spreadsheet (falling back to snapshot CSV if offline),
    filter to Seoul + Food Service categories, resolve coordinates via cache/geocoder,
    and upsert into SQLite.
    """
    source_used = "snapshot"
    csv_text = None

    if fetch_remote:
        try:
            req = urllib.request.Request(
                GOOGLE_SHEET_URL, headers={"User-Agent": "ChakhanHankki/1.0"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw_bytes = resp.read()
                csv_text = raw_bytes.decode("utf-8", errors="replace")
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(SNAPSHOT_PATH, "wb") as sf:
                    sf.write(raw_bytes)
                source_used = "google_sheets_live"
        except Exception as exc:
            source_used = f"snapshot_fallback ({type(exc).__name__})"

    if csv_text is None:
        if not os.path.exists(SNAPSHOT_PATH):
            raise RuntimeError("No live Google Sheet connection and no local snapshot CSV.")
        with open(SNAPSHOT_PATH, "r", encoding="utf-8") as sf:
            csv_text = sf.read()

    reader = csv.DictReader(io.StringIO(csv_text))
    geo_cache = _load_geo_cache()
    geo_dirty = False
    now = utc_now_iso()

    parsed_rows = []
    for r in reader:
        sido = (r.get("시도") or "").strip()
        gu = (r.get("시군") or "").strip()
        category = (r.get("업종") or "").strip()
        name = (r.get("업소명") or "").strip()
        address = (r.get("주소") or "").strip()

        # Scope rule: Seoul + Food Service only
        if sido != "서울특별시":
            continue
        if category not in ALLOWED_CATEGORIES:
            continue
        if not name or not address:
            continue

        menus = _parse_menus(r)
        if not menus:
            continue

        min_price = min(m["price"] for m in menus)
        main_menu = menus[0]["name"]
        main_price = menus[0]["price"]
        dong = extract_dong(address)
        ext_key = f"{gu}|{name}|{address}"

        if ext_key in geo_cache:
            g = geo_cache[ext_key]
            lat, lng, prec = g["lat"], g["lng"], g.get("precision", "cached")
        else:
            lat, lng, prec = geocode_restaurant(
                name, gu, address, allow_nominatim=False, allow_remote=False
            )
            geo_cache[ext_key] = {"lat": lat, "lng": lng, "precision": prec}
            geo_dirty = True

        parsed_rows.append(
            (
                ext_key,
                sido,
                gu,
                category,
                name,
                address,
                dong,
                json.dumps(menus, ensure_ascii=False),
                min_price,
                main_menu,
                main_price,
                lat,
                lng,
                prec,
                now,
            )
        )

    if geo_dirty:
        _save_geo_cache(geo_cache)

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM restaurants")
    cur.executemany(
        """
        INSERT INTO restaurants (
            external_key, sido, gu, category, name, address, dong,
            menus_json, min_price, main_menu, main_price, lat, lng, geo_precision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        parsed_rows,
    )
    cur.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync_at', ?)", (now,)
    )
    cur.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_source', ?)", (source_used,)
    )
    cur.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('row_count', ?)",
        (str(len(parsed_rows)),),
    )
    conn.commit()
    conn.close()

    return {
        "count": len(parsed_rows),
        "source": source_used,
        "synced_at": now,
    }
