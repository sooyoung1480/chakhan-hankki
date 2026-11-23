# 착한한끼 · 서울시 대학생 가성비 요식업 지도 (Prototype)

행정안전부 **착한가격업소(요식업 한정)** 공공데이터 Google Spreadsheet와 **OpenStreetMap(Leaflet)** 지도를 연동한 서울시 대학생 맞춤 가성비 맛집 지도 웹앱 프로토타입입니다.

## 주요 구현 기능 (린 캔버스 · IA · 사용자 과제 매트릭스 반영)

1. **Google Spreadsheet 실시간 백엔드 연동 + SQLite DB (`db.py`, `server.py`)**
   - 연동 시트: `1sMiFRC4RwI4xRnZ-RG2zInph6QAV6ywWpS4POHZDoZw` (`gid=553501454`)
   - 서울시 요식업(한식, 중식, 일식, 양식, 베이커리)만 자동 필터링하고 비요식업(이·미용업 등)은 제외합니다.
   - 상단 `↻` 버튼(`POST /api/sync`)으로 언제든 구글 스프레드시트의 최신 변경 사항을 SQLite DB(`data/app.db`)로 재동기화할 수 있습니다.
   - 주소 좌표 변환은 OpenStreetMap 기반 지오코딩(`geocoder.py`) + 서울 25개 자치구 반경 검증 + 캐시(`data/geocode_cache.json`)를 통해 처리합니다.

2. **OpenStreetMap 기반 지도 & 대학가·역세권 탐색 (`static/index.html`, `static/app.js`)**
   - Leaflet + OpenStreetMap 타일 + MarkerCluster 클러스터링
   - 서울 주요 대학가/지하철역 14곳 원클릭 바로가기 (신촌, 홍대입구, 혜화, 안암, 회기, 건대입구, 한양대/왕십리, 서울대입구, 흑석/중앙대, 숭실대, 숙대입구, 노량진, 강남/교대 등)
   - `📍 내 주변 찾기`(브라우저 GPS) 및 검색 반경(`500m`, `1km`, `2km`, `5km`, `구/전체`) 원형 오버레이 표시

3. **다차원 필터 (업종 · 가격 상한 · 검색 · 정렬)**
   - 업종 세분화: 전체 / 한식 / 중식 / 일식 / 양식 / 베이커리 (핀 색상 구분)
   - 가격 상한 필터: 5천원 이하 / 8천원 이하 / 1만원 이하 / 1.5만원 이하
   - 가게명·메뉴·동네 통합 검색 및 거리순/최저가순/찜 많은 순 정렬

4. **음식점 상세 · 길찾기 · 즐겨찾기 · 정보 수정 제보**
   - 대표 메뉴 및 전체 가격표 확인, 도로명 주소 복사
   - 외부 지도 길찾기 딥링크: 네이버지도 / 카카오맵 / OpenStreetMap
   - 회원 관리(이메일 가입·로그인, 체험용 계정 `student@seoul.ac.kr` / `demo1234!`) 및 즐겨찾기(`♥ 내 즐겨찾기` 지도 모아보기)
   - 가격 변동·폐업·메뉴 오류 제보 폼 (`POST /api/reports`) 및 제보 이력 확인
   - 서비스 핵심 지표 현황 모달 (`📊 현황`)

## 실행 방법

```powershell
cd C:\Users\USER\.gemini\antigravity\scratch\chakhan-hankki
python server.py
```

브라우저에서 `http://127.0.0.1:8090` 접속 (포트 변경 시 `PORT=8080 python server.py`).
