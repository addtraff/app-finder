#!/usr/bin/env bash
# Щопівгодини малими порціями: */30 * * * * /path/to/play-radar/catchup.sh
cd "$(dirname "$0")"
mkdir -p logs
{
  node src/cli.js stage keyword-serp   --geo US --limit 12
  node src/cli.js stage enrich-apps    --geo US --limit 40
  node src/cli.js stage enrich-reviews --geo US --limit 15
} >> "logs/catchup-$(date +%F).log" 2>&1
