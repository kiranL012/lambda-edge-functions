# Publishes a new Lambda@Edge version and updates the CloudFront association.
# Requires: AWS CLI configured with credentials that have Lambda + CloudFront
# permissions, and a function already created once via the console or
# `aws lambda create-function` (see README.md).
#
# Lambda@Edge functions MUST be created/updated in us-east-1, regardless of
# where your CloudFront origin lives.
#
# Usage: npm run deploy -- -FunctionName sfl-edge-worker -DistributionId EXXXXXXXXXXXXX -CacheBehaviorPathPattern "*"

param(
    [Parameter(Mandatory = $true)]
    [string]$FunctionName,

    [Parameter(Mandatory = $true)]
    [string]$DistributionId,

    [string]$CacheBehaviorPathPattern = "*"
)

$ErrorActionPreference = "Stop"

& "$PSScriptRoot\package.ps1"

$zipPath = Join-Path $PSScriptRoot "..\dist\function.zip"

Write-Host "Updating function code for $FunctionName (us-east-1)..."
aws lambda update-function-code `
    --region us-east-1 `
    --function-name $FunctionName `
    --zip-file "fileb://$zipPath" | Out-Null

Write-Host "Publishing new version..."
$publishResult = aws lambda publish-version `
    --region us-east-1 `
    --function-name $FunctionName | ConvertFrom-Json

$versionArn = $publishResult.FunctionArn
Write-Host "Published: $versionArn"

Write-Host ""
Write-Host "Next step (manual, one-time or via IaC):"
Write-Host "  Associate '$versionArn' with distribution '$DistributionId'"
Write-Host "  on the cache behavior matching path pattern '$CacheBehaviorPathPattern'"
Write-Host "  as an Origin Response trigger, then wait for propagation (several minutes)."
Write-Host ""
Write-Host "  See: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-how-it-works-publish.html"
