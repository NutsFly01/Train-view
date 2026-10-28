# Train View

Carte des trains circulant en France et dans une dizaine de pays européens, avec une position **estimée** à partir des horaires théoriques. L'idée : un [Flightradar24](https://www.flightradar24.com), mais pour les trains.

- icônes orientées dans le sens de la marche, mouvement fluide ;
- clic sur un train : panneau avec départ/arrivée, progression (km et temps), vitesse moyenne estimée, prochain arrêt, liste des arrêts et tracé du trajet ;
- « Suivre le train » pour garder la carte centrée dessus ;
- recherche d'un train (numéro, gare de départ ou d'arrivée) ou d'une gare ;
- URL partageable, comme sur Flightradar24 : `#46.60,2.40/6` (centre et zoom), `#46.60,2.40/6/6017` (train sélectionné) ;
- filtres par catégorie (grande vitesse, grandes lignes, régional, banlieue / S-Bahn) et par pays.

Pas de temps réel : la position est calculée en interpolant entre l'heure de départ d'une gare et l'heure d'arrivée à la suivante, en ligne droite entre les deux gares. Les retards, suppressions et travaux ne sont pas pris en compte.

## Lancer en local

```bash
npm install
npm run data    # télécharge les horaires et génère site/data/*.json
npm run serve   # http://localhost:8080
```

Ouvrez bien la page via `npm run serve` (ou une fois en ligne), pas en double-cliquant sur `index.html` : en `file://`, le navigateur ne peut pas charger les horaires et OpenStreetMap refuse les tuiles. Le fond de carte (OpenStreetMap) ne demande aucune clé d'API.

`npm run data` télécharge les horaires théoriques (GTFS) publiés en open data, sans clé d'API :

| Pays | Source |
| --- | --- |
| 🇫🇷 France | SNCF Voyageurs (TGV INOUI, OUIGO, Intercités, TER) — transport.data.gouv.fr |
| 🇩🇪 Allemagne | gtfs.de (grandes lignes et trains régionaux) |
| 🇨🇭 Suisse | opentransportdata.swiss (flux national, seuls les trains sont gardés) |
| 🇧🇪 Belgique | SNCB |
| 🇳🇱 Pays-Bas | OVapi (gtfs.ovapi.nl) |
| 🇪🇸 Espagne | Renfe (grandes lignes, moyenne distance, Cercanías) |
| 🇦🇹 Autriche | ÖBB (data.oebb.at) |
| 🇵🇱 Pologne | mkuran.pl (PKP Intercity, Polregio…) |
| 🇩🇰 Danemark | Rejseplanen |
| 🇳🇴 Norvège | Entur |
| 🇫🇮 Finlande | Fintraffic (digitraffic.fi), sans les trains de marchandises |
| 🇪🇪 Estonie | peatus.ee |
| 🇮🇪 Irlande | Transport for Ireland (Irish Rail) |

Quand le nom du fichier change chaque année (ÖBB, mkuran.pl…), le script le cherche sur la page de téléchargement. Si un fichier ne contient aucun train circulant aujourd'hui, il essaie le suivant.

Un pays dont le flux est indisponible est simplement ignoré. Les sources sont définies en haut de `scripts/build-data.mjs` : pour ajouter un pays, il suffit d'y ajouter l'URL de son flux GTFS. Options :

- `COUNTRIES="fr de"` : ne générer que certains pays ;
- `GTFS_FILES="fr:a.zip de:b.zip"` : utiliser des fichiers GTFS déjà téléchargés ;
- `DAYS=3` : nombre de jours couverts à partir d'aujourd'hui (3 par défaut).

Les trains transfrontaliers (TGV Paris–Francfort, par exemple) figurent dans les horaires des deux pays et peuvent apparaître en double.

Les données ne couvrent que quelques jours : relancez `npm run data` régulièrement.

## Mise en ligne (GitHub Pages)

Le workflow `.github/workflows/pages.yml` génère les données et publie le dossier `site/` à chaque push sur `main`, et tous les jours pour rafraîchir les horaires. Pour l'activer : **Settings → Pages → Source : GitHub Actions**.

## Organisation

- `scripts/build-data.mjs` : lit les fichiers GTFS (gares, courses, calendriers, horaires) et produit un JSON compact ;
- `site/app.js` : carte Leaflet, calcul des positions chaque seconde, filtres et panneau de détail ;
- `scripts/serve.mjs` : petit serveur statique pour le développement.
