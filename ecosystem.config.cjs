module.exports = {
  apps: [
    {
      name: "algoneo",
      script: "app_server.py",
      interpreter: process.platform === "win32" ? "python" : "python3",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        PYTHONUNBUFFERED: "1",
        PORT: 8090,
      },
    },
  ],
}
