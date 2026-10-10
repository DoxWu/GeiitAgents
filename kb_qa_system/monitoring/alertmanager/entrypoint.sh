#!/bin/sh
set -eu

rendered_config="$(mktemp /tmp/alertmanager.XXXXXX.yml)"
trap 'rm -f "$rendered_config"' EXIT HUP INT TERM
render-alertmanager-config \
  /etc/alertmanager/alertmanager.yml.template \
  "$rendered_config"
exec /usr/local/bin/alertmanager \
  --config.file="$rendered_config" \
  --storage.path=/alertmanager
