# Archive Personal Cloud NAS

Dropbox 스타일 파일 관리, 논문 데이터베이스, 이미지 갤러리와 지속 오디오 플레이어를 결합한 개인용 NAS 웹 애플리케이션입니다. Node.js 24 표준 라이브러리와 내장 SQLite를 사용하는 단일 모놀리스이며 npm 패키지는 필요하지 않습니다.

## 실행

```sh
git clone <repository-url> archive-nas
cd archive-nas
cp .env.example .env
docker compose up --build -d
```

브라우저에서 `http://localhost:4180`으로 접속합니다.

첫 접속에서 관리자 이름과 비밀번호를 등록한 뒤 **Files** 화면에서 저장소를 선택합니다.

- **기본 폴더 생성**: `.env`의 `STORAGE_DIR` 위치를 생성해 사용합니다.
- **기존 로컬 경로 연결**: 서버에 이미 존재하며 읽기·쓰기가 가능한 절대 경로를 사용합니다.

Docker 컨테이너에서는 마운트된 경로만 접근할 수 있습니다. 기본 Compose 설정은 호스트의 `STORAGE_DIR`을 컨테이너의 `/app/storage`에 연결하므로, 별도 경로를 직접 지정하려면 먼저 해당 경로를 Compose 볼륨으로 마운트해야 합니다.

```text
storage/                 원본 파일
storage/.trash/          휴지통
data/nas.db              파일·논문·세션 메타데이터
data/cache/              이미지 thumbnail / preview 캐시
```

외장 디스크를 기본 관리 폴더로 쓰려면 `.env`의 `STORAGE_DIR`을 호스트 경로로 변경합니다.

```env
STORAGE_DIR=/mnt/archive-nas/storage
```

## 기능

- 다중/Drag & Drop 업로드, 진행률, 다운로드, 폴더 생성, 이동, 이름 변경, 휴지통/복원
- 목록/격자 보기, 정렬, 즐겨찾기, 최근 파일, 전체 검색과 `Ctrl/Cmd + K`
- PDF 메타데이터 자동 추출, 논문 정보 편집/검색/필터와 PDF 뷰어
- WebP thumbnail/preview 캐시와 이미지 해상도 추출
- MP3/WAV/FLAC/M4A/OGG/AAC Range 스트리밍과 지속 오디오 플레이어
- scrypt 비밀번호, HttpOnly 세션, CSRF, 로그인 제한, 경로/심볼릭 링크 검증

## 외부 접속

Quick Tunnel을 사용할 때는 HTTPS용 Secure Cookie가 활성화됩니다.

```sh
docker compose -f compose.public.yaml up --build -d
docker compose -f compose.public.yaml logs -f tunnel
```

장기 운영에는 고정 도메인과 HTTPS reverse proxy를 권장합니다.

## K3s

```sh
sudo k3s kubectl create namespace archive-nas
sudo k3s kubectl -n archive-nas create secret generic archive-nas-auth \
  --from-literal=password='여기에-긴-비밀번호'
docker build -t archive-nas:latest .
docker save archive-nas:latest -o /tmp/archive-nas.tar
sudo k3s ctr images import /tmp/archive-nas.tar
sudo k3s kubectl apply -f k8s/archive-nas.yaml
```

기본 NodePort는 `30180`, 호스트 저장 경로는 `/mnt/archive-nas/storage`입니다.
