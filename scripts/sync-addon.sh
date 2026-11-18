#!/bin/sh
# The add-on builds from its own folder, so it carries copies of the bridge files.
# Run this after changing kamoer_bridge.py or kamoerx1.py at the repo root.
cd "$(dirname "$0")/.." && cp kamoer_bridge.py kamoerx1.py sentinel_kamoer_x1/ && echo "add-on copies updated"
