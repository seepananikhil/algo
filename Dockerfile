FROM node:22-alpine AS frontend-build

WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
COPY --from=frontend-build /web/dist ./web/dist

ENV HOST=0.0.0.0
ENV PORT=8000
EXPOSE 8000

CMD ["python", "app_server.py"]
