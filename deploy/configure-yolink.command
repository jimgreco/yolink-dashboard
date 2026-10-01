#!/bin/bash
set -eu
cd "$(dirname "$0")"
exec python3 configure-yolink.py
