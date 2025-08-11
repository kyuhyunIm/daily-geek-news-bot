# Daily Geek News Bot 🤖📰

매일 아침, 최신 기술 뉴스를 Slack으로 자동 전송하는 봇입니다. 다양한 한국 IT 회사들의 기술 블로그에서 뉴스를 수집하고 정리해 드립니다.

## 🚀 기능

- **자동 뉴스 수집**: 5개 주요 IT 기술 블로그의 RSS 피드에서 뉴스 자동 수집
- **스케줄링**: 매주 월~금 오전 9시에 자동으로 뉴스 전송
- **Slack 통합**: 슬래시 명령어(`/뉴스`)로 즉시 최신 뉴스 조회 가능
- **페이지네이션**: 버튼을 통한 이전 뉴스 탐색 기능
- **성능 모니터링**: 처리 시간 및 캐시 상태 실시간 추적

## 📊 뉴스 소스

- **GeekNewsFeed**: https://news.hada.io/rss/news
- **LINE Tech Blog**: https://techblog.lycorp.co.jp/ko/feed/index.xml
- **Coupang Engineering**: https://medium.com/feed/coupang-engineering
- **Toss Tech**: https://toss.tech/rss.xml
- **당근 Tech Blog**: https://medium.com/feed/daangn

## 🏗️ 프로젝트 구조

```
daily-geek-news-bot/
├── index.js              # 메인 애플리케이션 (Slack Bot, 스케줄러)
├── modules/
│   └── news.js           # 뉴스 수집 및 캐시 관리 모듈
├── package.json          # Node.js 의존성 관리
├── Dockerfile           # Docker 컨테이너 설정
├── .env                 # 환경 변수 (미포함)
└── README.md           # 프로젝트 문서

```

## 🛠️ 기술 스택

- **Runtime**: Node.js 18+
- **Framework**: Slack Bolt Framework
- **Dependencies**:
  - `@slack/bolt`: Slack 앱 개발 프레임워크
  - `rss-parser`: RSS 피드 파싱
  - `node-cron`: 작업 스케줄링
  - `dotenv`: 환경 변수 관리

## ⚙️ 설치 및 실행

### 1. 환경 설정

`.env` 파일을 생성하고 다음 변수들을 설정하세요:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_TARGET_CHANNEL=your-channel-id
PORT=8080
```

### 2. 의존성 설치

```bash
npm install
```

### 3. 개발 환경 실행

```bash
node index.js
```

### 4. Docker 실행

```bash
# 이미지 빌드
docker build -t daily-geek-news-bot .

# 컨테이너 실행
docker run -p 8080:8080 --env-file .env daily-geek-news-bot
```

## 📱 사용법

### 슬래시 명령어

- `/뉴스`: 최신 기술 뉴스 5개 조회
- 버튼 상호작용으로 이전 뉴스 탐색 가능

### 자동 전송

- **일정**: 매주 월~금 오전 9시 (Asia/Seoul 시간대)
- **내용**: 최신 기술 뉴스 5개 자동 전송

## 🔧 성능 최적화

- **캐시 시스템**: 뉴스 데이터를 15분 간격으로 자동 캐시
- **비동기 처리**: Promise 기반 효율적인 대기 메커니즘
- **중복 방지**: 초기화 플래그로 불필요한 업데이트 방지
- **모니터링**: 실시간 처리 시간 및 캐시 상태 추적

## 🏥 헬스 체크

애플리케이션은 포트 `8080`에서 HTTP 헬스 체크 엔드포인트를 제공합니다:

```bash
curl http://localhost:8080
# 응답: OK
```

## 🚨 오류 처리

- RSS 피드 파싱 실패 시 해당 소스 건너뛰기
- Slack API 오류 시 사용자에게 친화적 오류 메시지 표시
- 캐시 업데이트 실패 시 기존 캐시 데이터 유지

## 📝 로그

애플리케이션은 다음과 같은 로그를 제공합니다:

```
🚀 데일리 뉴스 전송 작업을 시작합니다.
✅ 뉴스가 성공적으로 전송되었습니다. (처리시간: 250ms, 캐시 상태: 45개 아이템)
📊 /뉴스 명령어 처리 완료 (처리시간: 120ms)
```
