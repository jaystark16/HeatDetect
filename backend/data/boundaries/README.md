# Boundaries

Built by `scripts/build_boundaries.py`, read by `backend/app/regions.py`.
Provenance and limitations: `backend/app/datasets.py` (`boundaries_india_states`,
`boundaries_neighbour_countries`).

| File | Source | Licence | Source SHA-256 |
|---|---|---|---|
| `india_states.geojson` | [datta07/INDIAN-SHAPEFILES](https://github.com/datta07/INDIAN-SHAPEFILES) `INDIA/INDIA_STATES.geojson`, commit `7b003e3` | MIT, see `LICENSE-india-states.txt` | `c5956ba39e399eeb0897873331cfd1faf998c7958159c10aa549db02d5e70446` |
| `neighbour_countries.geojson` | [Natural Earth](https://www.naturalearthdata.com/) 10m Admin 1, v5.1.2, `geojson/ne_10m_admin_1_states_provinces.geojson` | Public domain | `22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5` |

- **India follows India's official map.** Gilgit-Baltistan and Aksai Chin are in
  Ladakh, Pakistan-administered Kashmir in Jammu and Kashmir. India is tested first,
  so this holds where the neighbour file draws those areas otherwise.
- **Neighbours give the country only**; their province names are out of date.
- 36 Indian units: 28 states and 8 union territories, with Dadra and Nagar Haveli
  and Daman and Diu merged (2020).

Checked on 2026-10-23 against 32,138 locations: reference places (Leh, Gilgit,
Muzaffarabad, Aksai Chin, Hyderabad, Silvassa, Diu, Puducherry, Vizag, Kathmandu,
Lahore, Dhaka, Wagah) all assigned correctly; Natural Earth's India agreed on 98.4%
of Indian locations; of the 43 disagreements more than 1.5 km from a boundary,
OpenStreetMap sided with `india_states.geojson` in 42.
