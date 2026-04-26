// PM2 설정 — 운영 전용. (개발은 VS Code "Sentinel: Full Stack Debug" 사용)
//
// 운영 (한 줄):
//   cd backend && npm run release       ← frontend/backend 빌드 + pm2 startOrReload
//
// 세분 명령:
//   cd backend && npm run build:all     ← 양쪽 dist만 빌드
//   pm2 startOrReload ecosystem.config.cjs --only sentinel
//
// 공통:
//   pm2 list                 상태
//   pm2 logs sentinel        로그 스트림
//   pm2 stop  sentinel       정지
//   pm2 delete sentinel      목록에서 제거
//   pm2 save && pm2 startup  OS 부팅 시 자동 시작

const path = require('path');

const ROOT_DIR = __dirname;
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const LOG_DIR = path.join(ROOT_DIR, 'logs');

module.exports = {
  apps: [
    {
      name: 'sentinel',
      cwd: BACKEND_DIR,
      script: 'dist/server.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 5000,
      out_file: path.join(LOG_DIR, 'sentinel-out.log'),
      error_file: path.join(LOG_DIR, 'sentinel-err.log'),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3101,
      },
    },
  ],
};
