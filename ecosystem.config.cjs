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
      },
      env_mock: {
        NODE_ENV: 'development',
        PORT: 3101,
        SENTINEL_AGENT_MODE: 'mock'
      }
    }
  ]
};
