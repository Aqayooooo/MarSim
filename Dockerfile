# MarSim — backend + interfejs w jednym kontenerze.
#   docker build -t marsim .
#   docker run --rm -p 127.0.0.1:8000:8000 -v marsim-data:/data marsim     →  http://localhost:8000
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    MARSIM_HOST=0.0.0.0 PORT=8000 MARSIM_DATA=/data

WORKDIR /app
COPY requirements-runtime.txt .
RUN pip install --no-cache-dir -r requirements-runtime.txt

COPY index.html styles.css data-sources.json LICENSE ./
COPY src ./src
COPY vendor ./vendor
COPY backend ./backend
COPY data/demo ./data/demo
COPY data/missions ./data/missions

RUN useradd --create-home marsim && mkdir -p /data && chown marsim /data
USER marsim
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health',timeout=2)"
CMD ["python", "backend/server.py"]
