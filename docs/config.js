/**
 * 착한한끼 GitHub Pages 배포 설정 파일
 *
 * 1. Google Spreadsheet: 가게 목록·메뉴·가격 DB (Apps Script 없이 공개 시트 직접 연동)
 * 2. Supabase: 회원가입·로그인 · 내 즐겨찾기(찜) · 가격변동 제보 · 서비스 지표 저장용 클라우드 DB
 *    - 주의: 프론트엔드에는 공개 가능한 Publishable Key만 사용합니다. (secret/service_role 키 사용 금지)
 */
window.CHAKHAN_CONFIG = {
  GOOGLE_SHEET_ID: "1sMiFRC4RwI4xRnZ-RG2zInph6QAV6ywWpS4POHZDoZw",
  GOOGLE_SHEET_GID: "553501454",
  SUPABASE_URL: "https://pugdcqxgukszxfayrihe.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Wd2TJRppIikHOQmzoPo34Q_EBuKyaNE"
};
