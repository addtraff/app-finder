#!/usr/bin/env bash
# Добовий знімок через cron: 10 3 * * * /path/to/play-radar/run-daily.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
node src/cli.js daily >> "logs/daily-$(date +%F).log" 2>&1
