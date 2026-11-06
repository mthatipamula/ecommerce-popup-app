#!/usr/bin/env bash
# First-time deploy to GCP. Needs: gcloud (logged in), terraform, a project with billing.
#   ./scripts/gcp-deploy.sh <project-id> [region]
set -euo pipefail
PROJECT=${1:?usage: gcp-deploy.sh <project-id> [region]}
REGION=${2:-us-central1}
TAG=$(git rev-parse --short HEAD 2>/dev/null || date +%s)
TF="terraform -chdir=infra/terraform"

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com run.googleapis.com

$TF init -input=false
# 1. Registry first, so there's somewhere to push the image.
$TF apply -input=false -auto-approve -var project_id="$PROJECT" -var region="$REGION" \
  -target=google_artifact_registry_repository.app -target=google_project_service.apis
gcloud builds submit --region "$REGION" --tag "$REGION-docker.pkg.dev/$PROJECT/popup/popup:$TAG" .
# 2. Everything else, pointing at that image.
$TF apply -input=false -auto-approve -var project_id="$PROJECT" -var region="$REGION" -var image_tag="$TAG"
# Ask Cloud Run directly: Terraform's api_url output can still be empty right after a service is first created.
URL=$(gcloud run services describe popup-api --region "$REGION" --format='value(status.url)')
[ -n "$URL" ] || { echo "popup-api has no URL yet; check: gcloud run services describe popup-api --region $REGION" >&2; exit 1; }
# 3. Tell the app its own public URL (OAuth redirect, apply links), and publish the popup bundle.
$TF apply -input=false -auto-approve -var project_id="$PROJECT" -var region="$REGION" -var image_tag="$TAG" -var app_url="$URL"
docker run --rm --entrypoint cat "$REGION-docker.pkg.dev/$PROJECT/popup/popup:$TAG" /app/web/dist/popup.js > /tmp/popup.js 2>/dev/null \
  && gsutil -h "Cache-Control:public, max-age=300" cp /tmp/popup.js "gs://$PROJECT-popup-widget/popup.js" || true

echo
echo "API:        $URL"
echo "Storefront: $URL/demo/"
echo "Dashboard:  $URL/dashboard/   (token: gcloud secrets versions access latest --secret popup-admin-token)"
echo "Teardown:   terraform -chdir=infra/terraform destroy -var project_id=$PROJECT -var deletion_protection=false"
