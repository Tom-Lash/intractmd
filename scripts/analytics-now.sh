#!/bin/bash
# IntractMD Analytics — On-Demand Query
# Usage: bash scripts/analytics-now.sh
# Pulls today's and yesterday's data for both sites

GA4_PROPERTY_ID=545620540 \
GA_SERVICE_ACCOUNT_JSON="$(cat ~/.config/intractmd/ga-key.json | base64)" \
node /Users/tomlash/Documents/ddi-checker/scripts/analytics-report.js --dry-run

# Open the preview in browser
open /Users/tomlash/Documents/ddi-checker/logs/analytics-preview.html
