# Train View

Carte des trains SNCF (TGV INOUI, OUIGO, Intercités, TER…) circulant en France, avec une position **estimée** à partir des horaires théoriques. L'idée : un [Flightradar24](https://www.flightradar24.com), mais pour les trains.

- icônes orientées dans le sens de la marche, mouvement fluide ;
- clic sur un train : panneau avec départ/arrivée, progression (km et temps), vitesse moyenne estimée, prochain arrêt, liste des arrêts et tracé du trajet ;
- « Suivre le train » pour garder la carte centrée dessus ;
- recherche d'un train (numéro, gare de départ ou d'arrivée) ou d'une gare ;
- URL partageable, comme sur Flightradar24 : `#46.60,2.40/6` (centre et zoom), `#46.60,2.40/6/6017` (train sélectionné) ;
- filtres par type de train (TGV INOUI, OUIGO, TER…).

Pas de temps réel : la position est calculée en interpolant entre l'heure de départ d'une gare et l'heure d'arrivée à la suivante, en ligne droite entre les deux gares. Les retards, suppressions et travaux ne sont pas pris en compte.

## Lancer en local

```bash
npm install
npm run data    # télécharge les horaires SNCF et génère site/data/network.json
npm run serve   # http://localhost:8080
```

Ouvrez bien la page via `npm run serve` (ou une fois en ligne), pas en double-cliquant sur `index.html` : en `file://`, le navigateur ne peut pas charger les horaires et OpenStreetMap refuse les tuiles. Le fond de carte (OpenStreetMap) ne demande aucune clé d'API.

`npm run data` utilise les flux GTFS publiés par SNCF Voyageurs sur [transport.data.gouv.fr](https://transport.data.gouv.fr). Options :

- `GTFS_URLS="url1 url2"` : autres flux GTFS à télécharger (fusionnés) ;
- `GTFS_FILES="a.zip b.zip"` : fichiers GTFS déjà téléchargés ;
- `DAYS=7` : nombre de jours couverts par le fichier généré (7 par défaut).

Les données ne couvrent que quelques jours : relancez `npm run data` régulièrement.

## Mise en ligne (GitHub Pages)

Le workflow `.github/workflows/pages.yml` génère les données et publie le dossier `site/` à chaque push sur `main`, et tous les jours pour rafraîchir les horaires. Pour l'activer : **Settings → Pages → Source : GitHub Actions**.

## Organisation

- `scripts/build-data.mjs` : lit les fichiers GTFS (gares, courses, calendriers, horaires) et produit un JSON compact ;
- `site/app.js` : carte Leaflet, calcul des positions chaque seconde, filtres et panneau de détail ;
- `scripts/serve.mjs` : petit serveur statique pour le développement.
