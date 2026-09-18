"""Geographic primitives. Pure functions, so tested against known values."""

from __future__ import annotations

import math

import pytest

from app.geo import (
    GRID_DEGREES,
    bbox_contains,
    cell_centre,
    cell_id,
    haversine_m,
    neighbour_cells,
)


def test_haversine_zero_distance():
    assert haversine_m(22.0, 70.0, 22.0, 70.0) == pytest.approx(0.0, abs=1e-6)


def test_haversine_one_degree_latitude():
    """One degree of latitude is ~111.2 km anywhere on the globe."""
    metres = haversine_m(22.0, 70.0, 23.0, 70.0)
    assert metres == pytest.approx(111_195, rel=0.001)


def test_haversine_longitude_shrinks_with_latitude():
    """A degree of longitude is ~cos(lat) of a degree at the equator."""
    at_equator = haversine_m(0.0, 70.0, 0.0, 71.0)
    at_22n = haversine_m(22.0, 70.0, 22.0, 71.0)
    assert at_22n == pytest.approx(at_equator * math.cos(math.radians(22)), rel=0.001)


def test_haversine_is_symmetric():
    forward = haversine_m(23.755, 86.405, 22.345, 69.86)
    backward = haversine_m(22.345, 69.86, 23.755, 86.405)
    assert forward == pytest.approx(backward)


def test_haversine_known_pair():
    """Jharia to Jamnagar refinery, ~1,690 km apart."""
    metres = haversine_m(23.755, 86.405, 22.3368, 69.8666)
    assert 1_650_000 < metres < 1_730_000


def test_cell_id_is_stable_within_a_cell():
    """Two points inside the same ~1 km cell must share an id."""
    assert cell_id(23.7551, 86.4051) == cell_id(23.7599, 86.4099)


def test_cell_id_differs_across_boundary():
    assert cell_id(23.7599, 86.4051) != cell_id(23.7601, 86.4051)


def test_cell_id_uses_floor_not_round():
    """Floor keeps boundaries unambiguous; rounding would make 23.755 ambiguous."""
    assert cell_id(23.7500, 86.4000) == "2375:8640"


def test_cell_id_handles_negative_coordinates():
    """Floor must not fold negatives toward zero."""
    assert cell_id(-0.005, -0.005) == "-1:-1"


def test_cell_centre_is_inside_its_cell():
    cell = cell_id(23.7551, 86.4051)
    lat, lon = cell_centre(cell)
    assert cell_id(lat, lon) == cell
    assert abs(lat - 23.755) < GRID_DEGREES
    assert abs(lon - 86.405) < GRID_DEGREES


def test_neighbour_cells_includes_self_and_ring():
    cell = cell_id(23.755, 86.405)
    neighbours = neighbour_cells(cell, ring=1)
    assert cell in neighbours
    assert len(neighbours) == 9
    assert len(set(neighbours)) == 9


def test_neighbour_cells_ring_two():
    assert len(neighbour_cells(cell_id(23.755, 86.405), ring=2)) == 25


@pytest.mark.parametrize(
    ("lat", "lon", "expected"),
    [
        (23.755, 86.405, True),  # Jharia, inside
        (22.345, 69.866, True),  # Jamnagar, inside
        (51.5, -0.12, False),  # London, outside
        (6.0, 68.0, True),  # exactly the corner, inclusive
        (37.5, 98.0, True),  # opposite corner, inclusive
        (5.99, 68.0, False),  # just south
    ],
)
def test_bbox_contains(lat, lon, expected):
    """bbox order is GeoJSON: (min_lon, min_lat, max_lon, max_lat)."""
    assert bbox_contains((68.0, 6.0, 98.0, 37.5), lat, lon) is expected
