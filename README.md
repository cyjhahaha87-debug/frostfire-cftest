# SD Robot Battle - Multiplayer Prototype

WebSocket 기반 멀티플레이 프로토타입. Render + GitHub으로 배포 가능.

## 구조

```
multiplayer/
├─ package.json        # express + ws 의존성
├─ server.js           # 20Hz 스냅샷 브로드캐스트 + 간이 권위 서버
└─ public/
   └─ index.html       # 클라이언트 (Three.js)
```

## 로컬 테스트

```bash
cd multiplayer
npm install
npm start
```

브라우저에서 `http://localhost:3000` 열기. 여러 탭/창으로 열면 각각 다른 플레이어로 접속됩니다.

## Render 배포

1. 이 폴더 전체를 GitHub 리포로 푸시
2. Render에서 **New > Web Service**
3. 해당 리포 연결
4. 설정:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: Node
5. 배포 후 나오는 URL로 접속하면 어디서든 플레이 가능

**무료 티어 주의사항:**
- 15분 유휴 시 슬립 → 첫 접속자 30초 대기
- CPU/메모리 제약 있음 → 동시 접속 4~8명이 현실적
- 서버 리전은 가장 가까운 곳 선택 (Singapore 등)

## 통신 프로토콜

### Client → Server
- `{type: 'join', name: string}` — 접속
- `{type: 'state', x, y, z, rotY}` — 20Hz 위치/회전 전송
- `{type: 'shoot', origin, target, hitId?}` — 사격 이벤트

### Server → Client
- `{type: 'welcome', id, color, spawn, players}` — 초기 상태
- `{type: 'snapshot', t, players}` — 20Hz 전체 플레이어 상태
- `{type: 'player_joined' | 'player_left'}` — 접속/퇴장
- `{type: 'shoot_fx', shooterId, origin, target, hit}` — 사격 이펙트
- `{type: 'damage', targetId, hp, shooterId}` — 피격
- `{type: 'death' | 'respawn'}` — 사망/리스폰

## 권위 구조

- **위치**: 클라이언트 보고 기반 (치트 가능, 단 서버가 좌표 범위 clamp)
- **사격 판정**: 서버가 피해자와 claimed target 거리 3유닛 이내 검증
- **HP/리스폰**: 서버 권위

진짜 경쟁 게임이면 위치도 서버가 시뮬레이션해야 하지만, 프로토타입이라 단순화했습니다.

## 알려진 한계

1. **보간 없음** — 원격 플레이어가 선형 lerp로만 움직여서 약간 끊겨 보일 수 있음
2. **레이턴시 처리 없음** — 핑이 높으면 내 화면에서 맞췄는데 서버에서 빗나간 걸로 판정 가능
3. **충돌 동기화 없음** — 클라끼리 서로 겹칠 수 있음
4. **장애물은 클라 로컬** — 서버는 장애물 모름. 벽 뚫고 쏠 수 있음
5. **재접속 시 상태 복구 없음** — 끊기면 새 플레이어로 접속
