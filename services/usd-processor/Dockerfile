# Isolated OpenUSD processor (ARCHITECTURE.md "Heavy conversion container", ADR-023).
# Stages: base (pinned usd-core) -> test (adds pytest + tests; `npm run usd:build|usd:test`)
#         -> runtime (LAST, so it is the default target: what Wrangler builds for the Cloudflare Container).
# Runs as non-root. Locally the sandbox adds --network none, a read-only root FS and resource limits (README.md);
# on Cloudflare the Container is started with internet access disabled.
FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt && useradd --create-home --uid 10001 usd

FROM base AS test
COPY requirements-test.txt .
RUN pip install -r requirements-test.txt
COPY usd_processor ./usd_processor
COPY tests ./tests
RUN chown -R usd /app
USER usd
CMD ["python", "-m", "usd_processor", "--help"]

FROM base AS runtime
COPY usd_processor ./usd_processor
RUN chown -R usd /app
USER usd
EXPOSE 8080
CMD ["python", "-m", "usd_processor", "serve", "--port", "8080"]
