#!/bin/bash
set -e

PROJECT_ID="yiedgeko"
REGION="us-central1"
REPO="yieldgeko"
IMAGE="us-central1-docker.pkg.dev/${PROJECT_ID}/${REPO}/agent"
SERVICE="yieldgeko-agent"
ENV_FILE="packages/agent/.env"

echo "==> Loading env from ${ENV_FILE}..."
set -a
source <(grep -v '^\s*#' "${ENV_FILE}" | grep -v '^\s*$')
set +a

echo "==> Submitting build to Google Cloud Build (no local Docker needed)..."
gcloud builds submit \
  --config cloudbuild.yaml \
  --project "${PROJECT_ID}" \
  .

echo "==> Generating env vars file..."
grep -v '^\s*#' "${ENV_FILE}" | grep -v '^\s*$' | grep '=' | grep -v '^SSE_PORT=' | \
while IFS='=' read -r key value; do
  printf '%s: "%s"\n' "$key" "${value//\"/\\\"}"
done > /tmp/agent-env.yaml
printf 'FRONTEND_ORIGIN: "*"\nAGENT_ENVIRONMENT: "production"\nNODE_ENV: "production"\n' >> /tmp/agent-env.yaml

echo "==> Deploying to Cloud Run..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}:latest" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 1000 \
  --timeout 3600 \
  --env-vars-file /tmp/agent-env.yaml

echo ""
echo "==> Agent deployed. URL:"
gcloud run services describe "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format "value(status.url)"

echo ""
echo "==> Set this in Vercel:"
echo "    NEXT_PUBLIC_AGENT_SSE_URL=<above URL>/events"
