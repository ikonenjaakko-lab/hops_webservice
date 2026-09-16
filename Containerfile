FROM registry.access.redhat.com/ubi9/python-312:latest

WORKDIR /opt/app-root/src

ENV HOPS_HOST=0.0.0.0 \
    HOPS_PORT=8000 \
    HOPS_BASE_PATH="" \
    HOPS_FRONTEND_DIR=/opt/app-root/src/frontend \
    HOPS_CONFIG_FILE=/opt/app-root/src/config/app.json \
    HOPS_CONTENT_DIR=/opt/app-root/src/content \
    HOPS_DATA_DIR=/opt/app-root/src/data \
    HOPS_DATA_BASE_URL=/data \
    HOPS_TILE_URL=https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png

COPY . .

RUN python scripts/generate_dummy_data.py

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import json,urllib.request; json.load(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2))"

CMD ["python", "server.py"]
