#!/usr/bin/env bash
# Prépare les voies ferrées OpenStreetMap utilisées par build-data.mjs pour faire suivre les
# vraies voies aux trains dont l'opérateur ne publie pas de tracé.
#
# Pour chaque région Geofabrik listée par `node scripts/build-data.mjs --osm-regions` :
# téléchargement de l'extrait .osm.pbf, filtrage des voies (railway=rail, light_rail,
# narrow_gauge) avec osmium, puis écriture des voies avec les coordonnées de leurs nœuds
# au format OPL dans .cache/osm-rail/<région>.opl. Un fichier de moins de 30 jours est gardé.
#
# Nécessite osmium-tool (apt install osmium-tool).
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=.cache/osm-rail
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

for region in $(node scripts/build-data.mjs --osm-regions); do
  file="$OUT/${region//\//_}.opl"
  if [[ -f "$file" && -n "$(find "$file" -mtime -30)" ]]; then
    echo "$region : déjà à jour"
    continue
  fi
  echo "$region : téléchargement"
  if ! curl -fsSL --retry 3 -o "$TMP/region.osm.pbf" "https://download.geofabrik.de/${region}-latest.osm.pbf"; then
    echo "$region : échec du téléchargement, ignoré" >&2
    continue
  fi
  osmium tags-filter "$TMP/region.osm.pbf" w/railway=rail,light_rail,narrow_gauge -o "$TMP/rail.osm.pbf" --overwrite
  rm -f "$TMP/region.osm.pbf"
  osmium add-locations-to-ways "$TMP/rail.osm.pbf" -f opl -o "$file.tmp" --overwrite
  mv "$file.tmp" "$file"
  rm -f "$TMP/rail.osm.pbf"
  echo "$region : $(grep -c '^w' "$file") voies ($(du -h "$file" | cut -f1))"
done
