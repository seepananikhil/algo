# Deployable setup

This repo can run as a Python app and can be containerized or deployed to Azure App Service.

## Local run

python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app_server.py

Then open:
http://127.0.0.1:8090

## Docker

docker build -t algo-dashboard .
docker run -p 8000:8000 --env HOST=0.0.0.0 --env PORT=8000 algo-dashboard

## Azure App Service

1. Install Azure Developer CLI (`azd`)
2. Run:
   azd init
   azd up

This project includes `azure.yaml` and a Docker-based app service definition.

## Notes

- The server reads config from `fyers_config.json`.
- The Fyers access token is stored under `captured_data/fyers/fyers_access_token.json`.
- Use environment variables `HOST` and `PORT` for deployment.
