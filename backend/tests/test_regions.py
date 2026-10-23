"""State and country assignment, on the committed boundary files.

Expected regions are facts about real places, not values read back from the
boundary data, so a wrong boundary fails here.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, inspect, text

from app.db import init_schema
from app.regions import NEAR_BOUNDARY_M, assign_regions, load_regions

PLACES = [
    # (name, latitude, longitude, region, country)
    ("Leh", 34.1526, 77.5771, "Ladakh", "India"),
    ("Srinagar", 34.0837, 74.7973, "Jammu and Kashmir", "India"),
    ("Hyderabad", 17.385, 78.4867, "Telangana", "India"),
    ("Vijayawada", 16.5062, 80.648, "Andhra Pradesh", "India"),
    ("Visakhapatnam steel plant area", 17.609, 83.204, "Andhra Pradesh", "India"),
    ("Bhubaneswar", 20.2961, 85.8245, "Odisha", "India"),
    ("Jharia coalfield", 23.74, 86.41, "Jharkhand", "India"),
    ("Silvassa", 20.2738, 73.0083, "Dadra and Nagar Haveli and Daman and Diu", "India"),
    ("Daman", 20.3974, 72.8328, "Dadra and Nagar Haveli and Daman and Diu", "India"),
    ("Port Blair", 11.6234, 92.7265, "Andaman and Nicobar Islands", "India"),
    ("Tawang", 27.586, 91.8594, "Arunachal Pradesh", "India"),
    ("Kathmandu", 27.7172, 85.324, None, "Nepal"),
    ("Lahore", 31.5204, 74.3587, None, "Pakistan"),
    ("Dhaka", 23.8103, 90.4125, None, "Bangladesh"),
    ("Thimphu", 27.4728, 89.639, None, "Bhutan"),
]


@pytest.mark.parametrize("name,lat,lon,region,country", PLACES, ids=[p[0] for p in PLACES])
def test_real_places_land_in_their_state_or_country(name, lat, lon, region, country):
    (a,) = assign_regions([(lat, lon)])
    assert (a.region, a.country) == (region, country)


@pytest.mark.parametrize(
    "name,lat,lon,region",
    [
        ("Gilgit (Gilgit-Baltistan)", 35.9208, 74.308, "Ladakh"),
        ("Muzaffarabad (Pakistan-administered Kashmir)", 34.37, 73.47, "Jammu and Kashmir"),
        ("Aksai Chin", 35.2, 79.2, "Ladakh"),
    ],
)
def test_disputed_areas_follow_indias_official_map(name, lat, lon, region):
    (a,) = assign_regions([(lat, lon)])
    assert (a.region, a.country) == (region, "India"), name


def test_india_has_28_states_and_8_union_territories():
    india = {r.name for r in load_regions() if r.country == "India"}
    assert len(india) == 36
    assert "Ladakh" in india and "Telangana" in india
    assert "Daman and Diu" not in india, "merged into one union territory in 2020"


def test_neighbours_carry_no_out_of_date_province_names():
    assert all(r.name is None for r in load_regions() if r.country != "India")
    assert "Siachen Glacier" not in {r.country for r in load_regions()}


def test_open_sea_is_no_region():
    (a,) = assign_regions([(18.0, 66.5)])
    assert (a.region, a.country, a.alternatives) == (None, None, ())


def test_a_border_location_reports_the_other_side():
    # Wagah, on the India-Pakistan border.
    (a,) = assign_regions([(31.6047, 74.5725)])
    assert a.country == "India"
    assert "Pakistan" in a.alternatives


def test_a_coastline_is_not_a_boundary():
    # Visakhapatnam's shore: the sea is no region, so nothing to be confused with.
    (a,) = assign_regions([(17.6868, 83.2185)])
    assert a.region == "Andhra Pradesh"
    assert a.alternatives == ()


def test_far_from_any_boundary_has_no_alternatives():
    (a,) = assign_regions([(23.2599, 77.4126)])  # Bhopal
    assert a.region == "Madhya Pradesh" and a.alternatives == ()


def test_near_boundary_radius_covers_the_known_error_sources():
    # 300 m simplification plus up to ~0.8 km from a cell centre to a detection.
    assert NEAR_BOUNDARY_M >= 300 + 800


def test_empty_input():
    assert assign_regions([]) == []


def test_an_older_database_gains_the_region_columns(tmp_path):
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'old.db'}", future=True)
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE cell_context (cell_id VARCHAR(24) PRIMARY KEY, "
                "nearest_facility_id VARCHAR(40), nearest_facility_name VARCHAR(200), "
                "nearest_facility_category VARCHAR(24), distance_to_facility_m FLOAT, "
                "facilities_within_5km INTEGER NOT NULL, land_cover VARCHAR(16) NOT NULL, "
                "context_coverage VARCHAR(16) NOT NULL, computed_at DATETIME NOT NULL, "
                "code_version VARCHAR(16) NOT NULL)"
            )
        )
    init_schema(engine)
    columns = {c["name"] for c in inspect(engine).get_columns("cell_context")}
    assert {"region", "region_country", "region_alternatives"} <= columns
    init_schema(engine)  # idempotent
