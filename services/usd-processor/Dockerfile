# Isolated OpenUSD processor (ARCHITECTURE.md "Heavy conversion container").
# Runs as non-root; run with --network none and resource limits (see README.md).
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY usd_processor ./usd_processor
COPY tests ./tests
RUN useradd --create-home --uid 10001 usd && chown -R usd /app
USER usd
ENTRYPOINT []
CMD ["python", "-m", "usd_processor", "--help"]
