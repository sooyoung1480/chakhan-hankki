"""
Backend HTTP server and REST API for Chakhan-Hankki (서울시 대학생 가성비 요식업 지도).
Integrates live Google Spreadsheet sync, SQLite database, OSM geocoding, auth, favorites, and user reports.
"""

import json
import mimetypes
import os
import secrets
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

sys.path.insert(0, BASE_DIR)

from db import (
    SEOUL_CAMPUS_HUBS,
    get_conn,
    hash_password,
    init_db,
    sync_from_google_sheet,
    utc_now_iso,
    verify_password,
)
from geocoder import haversine_km


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def _get_current_user(handler: BaseHTTPRequestHandler):
    auth = handler.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:].strip()
    if not token:
        return None
    conn = get_conn()
    row = conn.execute(
        """
        SELECT u.id, u.email, u.nickname, u.university, u.created_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
        """,
        (token,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


class AppHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # Concise server log
        sys.stderr.write(f"[HTTP] {self.address_string()} - {format % args}\n")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/health":
            return _json_response(self, 200, {"status": "ok"})

        if path == "/api/meta":
            return self._handle_meta()

        if path == "/api/restaurants":
            return self._handle_list_restaurants(qs)

        if path.startswith("/api/restaurants/"):
            rid = path.split("/api/restaurants/", 1)[1].strip("/")
            if rid.isdigit():
                return self._handle_restaurant_detail(int(rid))

        if path == "/api/auth/me":
            user = _get_current_user(self)
            if not user:
                return _json_response(self, 401, {"error": "로그인이 필요합니다."})
            return _json_response(self, 200, {"user": user})

        if path == "/api/favorites":
            return self._handle_get_favorites()

        if path == "/api/reports":
            return self._handle_get_reports(qs)

        if path == "/api/analytics/summary":
            return self._handle_analytics_summary()

        return self._serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/sync":
            return self._handle_sync()

        if path == "/api/auth/register":
            return self._handle_register()

        if path == "/api/auth/login":
            return self._handle_login()

        if path == "/api/auth/logout":
            return self._handle_logout()

        if path == "/api/favorites/toggle":
            return self._handle_toggle_favorite()

        if path == "/api/reports":
            return self._handle_create_report()

        if path == "/api/analytics":
            return self._handle_log_analytics()

        return _json_response(self, 404, {"error": "Not found"})

    def _serve_static(self, path: str):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        rel = os.path.normpath(rel)
        if rel.startswith("..") or os.path.isabs(rel):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        full_path = os.path.join(STATIC_DIR, rel)
        if not os.path.isfile(full_path):
            full_path = os.path.join(STATIC_DIR, "index.html")
        if not os.path.isfile(full_path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        ctype, _ = mimetypes.guess_type(full_path)
        if not ctype:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(full_path, "rb") as f:
            data = f.read()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_meta(self):
        user = _get_current_user(self)
        conn = get_conn()
        gu_rows = conn.execute(
            "SELECT gu, COUNT(*) as cnt FROM restaurants GROUP BY gu ORDER BY gu"
        ).fetchall()
        cat_rows = conn.execute(
            "SELECT category, COUNT(*) as cnt FROM restaurants GROUP BY category ORDER BY cnt DESC"
        ).fetchall()
        meta_rows = conn.execute("SELECT key, value FROM sync_meta").fetchall()
        conn.close()

        sync_meta = {r["key"]: r["value"] for r in meta_rows}
        return _json_response(
            self,
            200,
            {
                "hubs": SEOUL_CAMPUS_HUBS,
                "gus": [{"gu": r["gu"], "count": r["cnt"]} for r in gu_rows],
                "categories": [{"category": r["category"], "count": r["cnt"]} for r in cat_rows],
                "sync": sync_meta,
                "user": user,
            },
        )

    def _handle_list_restaurants(self, qs: dict):
        user = _get_current_user(self)
        categories_raw = (qs.get("category", [""])[0] or "").strip()
        categories = [c.strip() for c in categories_raw.split(",") if c.strip() and c.strip() != "전체"]
        max_price_raw = (qs.get("max_price", [""])[0] or "").strip()
        gu = (qs.get("gu", [""])[0] or "").strip()
        q = (qs.get("q", [""])[0] or "").strip().lower()
        sort_by = (qs.get("sort", ["distance"])[0] or "distance").strip()
        fav_only = (qs.get("favorites_only", ["0"])[0] or "0").lower() in ("1", "true")

        lat_raw = (qs.get("lat", [""])[0] or "").strip()
        lng_raw = (qs.get("lng", [""])[0] or "").strip()
        radius_raw = (qs.get("radius_m", ["0"])[0] or "0").strip()

        ref_lat = float(lat_raw) if lat_raw else None
        ref_lng = float(lng_raw) if lng_raw else None
        radius_m = int(radius_raw) if radius_raw.isdigit() else 0

        sql = "SELECT * FROM restaurants WHERE 1=1"
        params = []
        if categories:
            placeholders = ",".join("?" for _ in categories)
            sql += f" AND category IN ({placeholders})"
            params.extend(categories)
        if gu and gu != "전체":
            sql += " AND gu = ?"
            params.append(gu)
        if max_price_raw.isdigit():
            sql += " AND min_price <= ?"
            params.append(int(max_price_raw))

        conn = get_conn()
        rows = conn.execute(sql, params).fetchall()

        fav_counts = {
            r["restaurant_key"]: r["cnt"]
            for r in conn.execute(
                "SELECT restaurant_key, COUNT(*) as cnt FROM favorites GROUP BY restaurant_key"
            ).fetchall()
        }
        user_favs = set()
        if user:
            user_favs = {
                r["restaurant_key"]
                for r in conn.execute(
                    "SELECT restaurant_key FROM favorites WHERE user_id = ?", (user["id"],)
                ).fetchall()
            }
        report_counts = {
            r["restaurant_key"]: r["cnt"]
            for r in conn.execute(
                "SELECT restaurant_key, COUNT(*) as cnt FROM reports GROUP BY restaurant_key"
            ).fetchall()
        }
        conn.close()

        items = []
        for r in rows:
            ext_key = r["external_key"]
            if fav_only and ext_key not in user_favs:
                continue

            menus = json.loads(r["menus_json"])
            if q:
                haystack = " ".join(
                    [r["name"], r["gu"], r["dong"], r["address"], r["category"]]
                    + [m["name"] for m in menus]
                ).lower()
                if q not in haystack:
                    continue

            dist_m = None
            if ref_lat is not None and ref_lng is not None:
                dist_m = round(haversine_km(ref_lat, ref_lng, r["lat"], r["lng"]) * 1000)
                if radius_m > 0 and dist_m > radius_m:
                    continue

            items.append(
                {
                    "id": r["id"],
                    "external_key": ext_key,
                    "gu": r["gu"],
                    "dong": r["dong"],
                    "category": r["category"],
                    "name": r["name"],
                    "address": r["address"],
                    "menus": menus,
                    "min_price": r["min_price"],
                    "main_menu": r["main_menu"],
                    "main_price": r["main_price"],
                    "lat": r["lat"],
                    "lng": r["lng"],
                    "geo_precision": r["geo_precision"],
                    "distance_m": dist_m,
                    "favorite_count": fav_counts.get(ext_key, 0),
                    "is_favorite": ext_key in user_favs,
                    "report_count": report_counts.get(ext_key, 0),
                }
            )

        if sort_by == "price_asc":
            items.sort(key=lambda x: (x["min_price"], x["distance_m"] if x["distance_m"] is not None else 999999))
        elif sort_by == "favorites":
            items.sort(key=lambda x: (-x["favorite_count"], x["min_price"]))
        else:
            items.sort(key=lambda x: (x["distance_m"] if x["distance_m"] is not None else 999999, x["min_price"]))

        return _json_response(
            self,
            200,
            {
                "items": items,
                "total": len(items),
                "center": {"lat": ref_lat, "lng": ref_lng},
            },
        )

    def _handle_restaurant_detail(self, rid: int):
        user = _get_current_user(self)
        conn = get_conn()
        r = conn.execute("SELECT * FROM restaurants WHERE id = ?", (rid,)).fetchone()
        if not r:
            conn.close()
            return _json_response(self, 404, {"error": "업소를 찾을 수 없습니다."})

        ext_key = r["external_key"]
        fav_cnt = conn.execute(
            "SELECT COUNT(*) as cnt FROM favorites WHERE restaurant_key = ?", (ext_key,)
        ).fetchone()["cnt"]
        is_fav = False
        if user:
            is_fav = (
                conn.execute(
                    "SELECT 1 FROM favorites WHERE user_id = ? AND restaurant_key = ?",
                    (user["id"], ext_key),
                ).fetchone()
                is not None
            )
        reports = conn.execute(
            """
            SELECT id, report_type, reported_price, detail, status, created_at
            FROM reports
            WHERE restaurant_key = ?
            ORDER BY id DESC
            LIMIT 10
            """,
            (ext_key,),
        ).fetchall()
        conn.close()

        return _json_response(
            self,
            200,
            {
                "item": {
                    "id": r["id"],
                    "external_key": ext_key,
                    "gu": r["gu"],
                    "dong": r["dong"],
                    "category": r["category"],
                    "name": r["name"],
                    "address": r["address"],
                    "menus": json.loads(r["menus_json"]),
                    "min_price": r["min_price"],
                    "main_menu": r["main_menu"],
                    "main_price": r["main_price"],
                    "lat": r["lat"],
                    "lng": r["lng"],
                    "geo_precision": r["geo_precision"],
                    "favorite_count": fav_cnt,
                    "is_favorite": is_fav,
                    "reports": [dict(rep) for rep in reports],
                }
            },
        )

    def _handle_sync(self):
        try:
            result = sync_from_google_sheet(fetch_remote=True)
            return _json_response(self, 200, {"ok": True, **result})
        except Exception as exc:
            return _json_response(self, 500, {"ok": False, "error": str(exc)})

    def _handle_register(self):
        body = _read_json_body(self)
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""
        nickname = (body.get("nickname") or "").strip() or (email.split("@")[0] if "@" in email else "대학생")
        university = (body.get("university") or "").strip()
        agreed = bool(body.get("agreed_terms", False))

        if not email or "@" not in email:
            return _json_response(self, 400, {"error": "올바른 이메일 주소를 입력해 주세요."})
        if len(password) < 4:
            return _json_response(self, 400, {"error": "비밀번호는 4자 이상 입력해 주세요."})
        if not agreed:
            return _json_response(self, 400, {"error": "필수 이용약관에 동의해 주세요."})

        conn = get_conn()
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            conn.close()
            return _json_response(self, 409, {"error": "이미 가입된 이메일입니다."})

        now = utc_now_iso()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO users (email, password_hash, nickname, university, agreed_terms, created_at)
            VALUES (?, ?, ?, ?, 1, ?)
            """,
            (email, hash_password(password), nickname, university, now),
        )
        user_id = cur.lastrowid
        token = secrets.token_urlsafe(32)
        cur.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user_id, now),
        )
        conn.commit()
        user = dict(
            conn.execute(
                "SELECT id, email, nickname, university, created_at FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
        )
        conn.close()
        return _json_response(self, 201, {"token": token, "user": user})

    def _handle_login(self):
        body = _read_json_body(self)
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""

        conn = get_conn()
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            conn.close()
            return _json_response(self, 401, {"error": "이메일 또는 비밀번호가 올바르지 않습니다."})

        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, row["id"], utc_now_iso()),
        )
        conn.commit()
        user = {
            "id": row["id"],
            "email": row["email"],
            "nickname": row["nickname"],
            "university": row["university"],
            "created_at": row["created_at"],
        }
        conn.close()
        return _json_response(self, 200, {"token": token, "user": user})

    def _handle_logout(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:].strip()
            conn = get_conn()
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
            conn.close()
        return _json_response(self, 200, {"ok": True})

    def _handle_get_favorites(self):
        user = _get_current_user(self)
        if not user:
            return _json_response(self, 401, {"error": "로그인이 필요합니다."})
        conn = get_conn()
        rows = conn.execute(
            """
            SELECT r.* FROM favorites f
            JOIN restaurants r ON r.external_key = f.restaurant_key
            WHERE f.user_id = ?
            ORDER BY f.id DESC
            """,
            (user["id"],),
        ).fetchall()
        conn.close()
        items = []
        for r in rows:
            items.append(
                {
                    "id": r["id"],
                    "external_key": r["external_key"],
                    "gu": r["gu"],
                    "dong": r["dong"],
                    "category": r["category"],
                    "name": r["name"],
                    "address": r["address"],
                    "menus": json.loads(r["menus_json"]),
                    "min_price": r["min_price"],
                    "main_menu": r["main_menu"],
                    "main_price": r["main_price"],
                    "lat": r["lat"],
                    "lng": r["lng"],
                    "is_favorite": True,
                }
            )
        return _json_response(self, 200, {"items": items})

    def _handle_toggle_favorite(self):
        user = _get_current_user(self)
        if not user:
            return _json_response(self, 401, {"error": "즐겨찾기를 저장하려면 로그인이 필요합니다."})
        body = _read_json_body(self)
        key = (body.get("restaurant_key") or "").strip()
        if not key:
            return _json_response(self, 400, {"error": "restaurant_key가 필요합니다."})

        conn = get_conn()
        existing = conn.execute(
            "SELECT id FROM favorites WHERE user_id = ? AND restaurant_key = ?",
            (user["id"], key),
        ).fetchone()
        if existing:
            conn.execute("DELETE FROM favorites WHERE id = ?", (existing["id"],))
            is_fav = False
        else:
            conn.execute(
                "INSERT INTO favorites (user_id, restaurant_key, created_at) VALUES (?, ?, ?)",
                (user["id"], key, utc_now_iso()),
            )
            is_fav = True
        cnt = conn.execute(
            "SELECT COUNT(*) as cnt FROM favorites WHERE restaurant_key = ?", (key,)
        ).fetchone()["cnt"]
        conn.commit()
        conn.close()
        return _json_response(self, 200, {"is_favorite": is_fav, "favorite_count": cnt})

    def _handle_create_report(self):
        user = _get_current_user(self)
        body = _read_json_body(self)
        key = (body.get("restaurant_key") or "").strip()
        name = (body.get("restaurant_name") or "").strip()
        rtype = (body.get("report_type") or "price_change").strip()
        reported_price_raw = str(body.get("reported_price") or "").strip().replace(",", "")
        detail = (body.get("detail") or "").strip()

        if not key or not detail:
            return _json_response(self, 400, {"error": "식당 정보와 수정 내용을 입력해 주세요."})

        reported_price = int(reported_price_raw) if reported_price_raw.isdigit() else None
        now = utc_now_iso()
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO reports (restaurant_key, restaurant_name, user_id, report_type, reported_price, detail, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, '접수됨', ?)
            """,
            (key, name, user["id"] if user else None, rtype, reported_price, detail, now),
        )
        rid = cur.lastrowid
        conn.commit()
        row = dict(conn.execute("SELECT * FROM reports WHERE id = ?", (rid,)).fetchone())
        conn.close()
        return _json_response(self, 201, {"ok": True, "report": row})

    def _handle_get_reports(self, qs: dict):
        key = (qs.get("restaurant_key", [""])[0] or "").strip()
        conn = get_conn()
        if key:
            rows = conn.execute(
                "SELECT * FROM reports WHERE restaurant_key = ? ORDER BY id DESC LIMIT 30",
                (key,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM reports ORDER BY id DESC LIMIT 50"
            ).fetchall()
        conn.close()
        return _json_response(self, 200, {"items": [dict(r) for r in rows]})

    def _handle_log_analytics(self):
        body = _read_json_body(self)
        etype = (body.get("event_type") or "").strip()
        payload = body.get("payload") or {}
        if not etype:
            return _json_response(self, 400, {"error": "event_type required"})
        conn = get_conn()
        conn.execute(
            "INSERT INTO analytics_events (event_type, payload_json, created_at) VALUES (?, ?, ?)",
            (etype, json.dumps(payload, ensure_ascii=False), utc_now_iso()),
        )
        conn.commit()
        conn.close()
        return _json_response(self, 200, {"ok": True})

    def _handle_analytics_summary(self):
        conn = get_conn()
        total_events = conn.execute("SELECT COUNT(*) as cnt FROM analytics_events").fetchone()["cnt"]
        by_type = conn.execute(
            "SELECT event_type, COUNT(*) as cnt FROM analytics_events GROUP BY event_type ORDER BY cnt DESC"
        ).fetchall()
        total_reports = conn.execute("SELECT COUNT(*) as cnt FROM reports").fetchone()["cnt"]
        total_favs = conn.execute("SELECT COUNT(*) as cnt FROM favorites").fetchone()["cnt"]
        total_users = conn.execute("SELECT COUNT(*) as cnt FROM users").fetchone()["cnt"]
        total_rest = conn.execute("SELECT COUNT(*) as cnt FROM restaurants").fetchone()["cnt"]
        conn.close()
        return _json_response(
            self,
            200,
            {
                "restaurants": total_rest,
                "users": total_users,
                "favorites": total_favs,
                "reports": total_reports,
                "events_total": total_events,
                "events_by_type": [dict(r) for r in by_type],
            },
        )


def bootstrap_and_run(port: int = 8090):
    init_db()
    conn = get_conn()
    cnt = conn.execute("SELECT COUNT(*) as cnt FROM restaurants").fetchone()["cnt"]
    conn.close()
    if cnt == 0:
        print("Initial database empty — syncing from snapshot / Google Sheet...")
        info = sync_from_google_sheet(fetch_remote=False)
        print("Bootstrapped restaurants:", info)

    server = ThreadingHTTPServer(("0.0.0.0", port), AppHandler)
    print(f"Chakhan-Hankki server listening on http://0.0.0.0:{port}")
    server.serve_forever()


if __name__ == "__main__":
    p = int(os.environ.get("PORT", "8090"))
    bootstrap_and_run(p)
