# Joule4Sales

SAP AI Core Calculator의 가격표와 계산식을 이용해 월간 CU를 견적 내는 웹 애플리케이션입니다. 화면은 React, API는 Django로 분리되어 있으며 기존에 검증된 Node.js 계산 엔진을 Django가 호출합니다. 따라서 계산식과 가격표는 한 곳(`src/`, `data/`)에서 계속 관리됩니다.

## 구조

```text
frontend/                  React + Vite 사용자 화면
backend/                   Django REST API
  api/                     모델 조회·단가 조회·견적 엔드포인트
src/                       기존 검증된 가격 계산 엔진 (Node.js)
data/                      모델, 가격, 정책 데이터
test/                      계산 엔진 회귀 테스트
```

## 실행

사전 요구 사항은 Node.js 20+, Python 3.10+입니다. 두 터미널에서 아래 명령을 실행하세요.

```bash
# 터미널 1: 계산 엔진 및 Django API
npm ci
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python backend/manage.py runserver
```

```bash
# 터미널 2: React 개발 서버
cd frontend
npm install
npm run dev
```

브라우저에서 Vite가 표시한 주소(기본 `http://localhost:5173`)를 엽니다. 개발 서버는 `/api` 요청을 Django(`http://127.0.0.1:8000`)로 프록시합니다.

## API

| Method | Endpoint | 설명 |
| --- | --- | --- |
| GET | `/api/health/` | API 상태 |
| GET | `/api/models/?query=gpt-4.1` | 모델 검색 |
| POST | `/api/pricing/` | 모델 버전별 단가와 입력 규칙 |
| GET | `/api/compute-instances/` | Compute 인스턴스 검색 |
| POST | `/api/estimates/` | 월간 CU 견적 |

`POST /api/estimates/`의 본문은 기존 견적 입력 형식입니다.

```json
{
  "foundationModels": [{
    "modelId": "gpt4.1mini",
    "version": "2025-04-14",
    "pricingMode": "Standard",
    "usage": {
      "inputTokensPerRequest": 2000,
      "outputTokensPerRequest": 500,
      "requestsPerMonth": 10000
    }
  }]
}
```

## 검증

```bash
npm test
npm run test:backend
cd frontend && npm run build
```

`monthlyCUExact`와 항목별 비용은 정밀도 손실을 막기 위해 문자열로 반환됩니다. 이 결과는 SAP의 공식 견적 또는 청구서가 아닙니다.

