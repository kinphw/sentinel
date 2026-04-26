// 단일 진입점. mock/live 분기는 프론트엔드 헤더 토글로 세션 단위 결정.
module.exports = {
  apps: [
    {
      name: 'sentinel',
      cwd: __dirname + '/backend',
      script: 'dist/server.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3101
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3101
      }
    }
  ]
};
