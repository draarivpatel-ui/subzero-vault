FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    VAULT_HOST=0.0.0.0 \
    VAULT_PORT=8090 \
    VAULT_DB=/data/vault.db

WORKDIR /app
COPY server ./server
COPY tests/fixtures ./tests/fixtures
COPY index.html styles.css engine.js app.js samples.js favicon.svg ./
COPY fonts ./fonts
COPY img ./img

# The server starts as root only long enough to chown /data and /backups, then drops to uid 10001.
RUN mkdir -p /data /backups

VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3)"]

CMD ["python3", "server/app.py"]
