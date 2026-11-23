# GitHub Pages + Supabase + Google Sheets 배포 가이드

이 가이드를 따라 설정하면 **PC가 꺼져 있어도 24시간 언제든 접속 가능한 공개 링크**가 만들어집니다.

---

## 1. 왜 Google Sheets에 Apps Script가 없어도 되나요?
- 예전에 Apps Script가 필요했던 경우는 **웹앱이 시트에 글을 쓰거나(저장)** **비공개 시트**를 읽을 때입니다.
- 현재 착한가격업소 시트는 **"링크가 있는 모든 사용자 보기 가능"** 상태이므로, 구글 시트의 공개 읽기 주소(`gviz/tq?tqx=out:json`)를 통해 브라우저가 **Apps Script 없이도 실시간으로 가게 목록·가격을 읽어옵니다.**
- 반대로 **회원가입 · 로그인 · 찜하기 · 가격변동 제보**처럼 사용자가 저장하는 데이터만 **Supabase**가 담당합니다.

---

## 2. Supabase DB 구성 방법 (약 3분)

1. [Supabase](https://supabase.com) 로그인 → **New Project** 클릭
   - Name: `chakhan-hankki` (원하는 이름)
   - Database Password: 임의의 비밀번호 입력 후 기억해 두기
   - Region: **Northeast Asia (Seoul)** 선택 후 **Create new project**
2. 프로젝트 생성이 끝나면 왼쪽 메뉴 **SQL Editor** 클릭 → **New query**
   - [docs/supabase_schema.sql](./docs/supabase_schema.sql) 파일 내용을 통째로 복사해 붙여넣고 **Run** 클릭 (`Success` 확인)
   - 생성되는 테이블: `profiles` (회원 닉네임·학교), `favorites` (개인 찜 목록), `reports` (가격변동·오류 제보), `analytics_events` (핵심지표 로그)
3. *(추천 - 테스트·시연용)* 왼쪽 메뉴 **Authentication → Providers → Email**
   - **Confirm email** 스위치를 **OFF**로 끄면, 이메일 인증 링크를 누르지 않아도 가입 즉시 로그인됩니다.
4. 왼쪽 하단 **Project Settings (톱니바퀴) → Data API / API Keys**
   - **Project URL** (예: `https://xxxx.supabase.co`) 복사
   - **Publishable / anon key** (`eyJ...` 또는 `sb_publishable_...`) 복사
   - ⚠️ **`service_role` / `secret` 키는 절대 복사해서 넣지 마세요!**
5. [docs/config.js](./docs/config.js) 파일을 열어 아래 두 칸에 붙여넣기 후 저장:
   ```js
   SUPABASE_URL: "여기에_Project_URL",
   SUPABASE_ANON_KEY: "여기에_anon_또는_publishable_key"
   ```

---

## 3. GitHub 등록 및 24시간 무료 배포 방법 (약 2분)

1. [GitHub](https://github.com) 로그인 → 우측 상단 **`+` → New repository**
   - Repository name: `chakhan-hankki`
   - **Public** 선택 → **Create repository**
2. 생성된 저장소 화면에서 **uploading an existing file** 클릭
   - `C:\Users\USER\.gemini\antigravity\scratch\chakhan-hankki` 폴더 안의 내용(특히 **`docs` 폴더 전체**)을 드래그 앤 드롭하고 **Commit changes** 클릭
   - *(만약 드래그 앤 드롭 시 폴더가 안 올라가면 `docs` 폴더를 압축하지 말고 파일 탐색기에서 `docs` 폴더 자체를 끌어다 놓으세요.)*
3. 저장소 상단 메뉴 **Settings → 왼쪽 메뉴 Pages** 클릭
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` / **`/docs`** 선택 → **Save** 클릭
4. 1~2분 뒤 상단에 나타나는 주소로 접속!
   - 예: **`https://<본인깃허브아이디>.github.io/chakhan-hankki/`**
5. *(중요)* Supabase 대시보드 **Authentication → URL Configuration**의 **Site URL**과 **Redirect URLs**에 위 GitHub Pages 주소를 추가해 두면 인증 흐름이 완벽하게 동작합니다.
