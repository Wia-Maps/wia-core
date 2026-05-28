#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import os
from pathlib import Path
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
from urllib import error, parse, request


RoutePoint = Tuple[float, float]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def log(message: str) -> None:
    print(f"[{utc_now_iso()}] {message}")


def summarize_discarded_batches(discarded_batches: Sequence["PreparedBatch"]) -> str:
    if not discarded_batches:
        return ""

    reason_counts: Dict[str, int] = {}
    example_messages: List[str] = []
    for discarded in discarded_batches:
        reason = discarded.discard_reason or "unknown"
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
        if len(example_messages) < 5:
            flag_suffix = (
                f" flags={','.join(discarded.quality_flags)}"
                if discarded.quality_flags
                else ""
            )
            example_messages.append(
                f"{discarded.batch.batch_id}: {reason}{flag_suffix}"
            )

    parts = [f"{reason}={count}" for reason, count in sorted(reason_counts.items())]
    summary = "Discard reasons: " + ", ".join(parts) + "."
    if example_messages:
        summary += " Examples: " + "; ".join(example_messages) + "."
    return summary


def parse_dotenv_value(raw_value: str) -> str:
    value = raw_value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def load_dotenv_file(path: Path) -> None:
    if not path.exists() or not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        normalized_key = key.strip()
        if not normalized_key:
            continue

        os.environ.setdefault(normalized_key, parse_dotenv_value(value))


def load_default_env_files() -> None:
    script_dir = Path(__file__).resolve().parent
    load_dotenv_file(script_dir / ".env")
    load_dotenv_file(script_dir / ".env.local")


def env_string(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    if value is None:
        return default

    normalized = value.strip()
    return normalized if normalized else default


def env_int(name: str, default: int) -> int:
    value = env_string(name)
    if value is None:
        return default

    try:
        return int(value)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    value = env_string(name)
    if value is None:
        return default

    try:
        return float(value)
    except ValueError:
        return default


def env_bool(name: str, default: bool) -> bool:
    value = env_string(name)
    if value is None:
        return default

    return value.lower() in {"1", "true", "yes", "on"}


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def average(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / max(1, len(values))


def to_radians(degrees: float) -> float:
    return degrees * math.pi / 180.0


def normalize_heading(heading: Optional[float]) -> Optional[float]:
    if heading is None or not math.isfinite(heading):
        return None
    normalized = heading % 360.0
    return normalized + 360.0 if normalized < 0 else normalized


def heading_delta(left: Optional[float], right: Optional[float]) -> Optional[float]:
    if left is None or right is None:
        return None
    difference = abs(normalize_heading(left) - normalize_heading(right))
    return min(difference, 360.0 - difference)


def axis_heading_delta(point_heading: Optional[float], segment_heading: Optional[float]) -> Optional[float]:
    if point_heading is None or segment_heading is None:
        return None
    forward_delta = heading_delta(point_heading, segment_heading)
    reverse_delta = heading_delta(point_heading, (segment_heading + 180.0) % 360.0)
    if forward_delta is None:
        return reverse_delta
    if reverse_delta is None:
        return forward_delta
    return min(forward_delta, reverse_delta)


def calculate_bearing(left: RoutePoint, right: RoutePoint) -> Optional[float]:
    if left == right:
        return None

    left_lat = to_radians(left[0])
    right_lat = to_radians(right[0])
    delta_lng = to_radians(right[1] - left[1])
    x = math.sin(delta_lng) * math.cos(right_lat)
    y = math.cos(left_lat) * math.sin(right_lat) - math.sin(left_lat) * math.cos(right_lat) * math.cos(delta_lng)
    return normalize_heading(math.degrees(math.atan2(x, y)))


def haversine_meters(left: RoutePoint, right: RoutePoint) -> float:
    earth_radius_m = 6371000.0
    left_lat, left_lng = left
    right_lat, right_lng = right

    delta_lat = to_radians(right_lat - left_lat)
    delta_lng = to_radians(right_lng - left_lng)
    a = (
        math.sin(delta_lat / 2.0) ** 2
        + math.cos(to_radians(left_lat))
        * math.cos(to_radians(right_lat))
        * math.sin(delta_lng / 2.0) ** 2
    )
    return earth_radius_m * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def path_distance_meters(points: Sequence[RoutePoint]) -> int:
    distance = 0.0
    for index in range(1, len(points)):
        distance += haversine_meters(points[index - 1], points[index])
    return max(1, int(round(distance)))


def simplify_points(points: Sequence[RoutePoint], threshold_m: float) -> List[RoutePoint]:
    if len(points) <= 2:
        return list(points)

    simplified = [points[0]]
    for point in points[1:-1]:
        if haversine_meters(simplified[-1], point) >= threshold_m:
            simplified.append(point)
    simplified.append(points[-1])
    return simplified


def quantize_point(point: RoutePoint, decimals: int = 5) -> Tuple[float, float]:
    return (round(point[0], decimals), round(point[1], decimals))


def canonicalize_points(points: Sequence[RoutePoint]) -> List[RoutePoint]:
    if len(points) < 2:
        return list(points)
    start = quantize_point(points[0])
    end = quantize_point(points[-1])
    return list(reversed(points)) if end < start else list(points)


def project_to_local_xy(point: RoutePoint, reference_latitude: float) -> Tuple[float, float]:
    latitude, longitude = point
    x = to_radians(longitude) * 6371000.0 * math.cos(to_radians(reference_latitude))
    y = to_radians(latitude) * 6371000.0
    return x, y


def point_to_segment_distance_meters(point: RoutePoint, start: RoutePoint, end: RoutePoint) -> float:
    reference_latitude = (point[0] + start[0] + end[0]) / 3.0
    px, py = project_to_local_xy(point, reference_latitude)
    sx, sy = project_to_local_xy(start, reference_latitude)
    ex, ey = project_to_local_xy(end, reference_latitude)

    dx = ex - sx
    dy = ey - sy
    if dx == 0 and dy == 0:
        return math.hypot(px - sx, py - sy)

    projection = ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)
    projection = clamp(projection, 0.0, 1.0)
    closest_x = sx + projection * dx
    closest_y = sy + projection * dy
    return math.hypot(px - closest_x, py - closest_y)


def points_to_line_string(points: Sequence[RoutePoint]) -> Dict[str, Any]:
    return {
        "type": "LineString",
        "coordinates": [[point[1], point[0]] for point in points],
    }


def replace_window_with_straight_segment(
    points: Sequence[RoutePoint], start_index: int, end_index: int
) -> List[RoutePoint]:
    start_point = points[start_index]
    end_point = points[end_index]
    replacement = (
        [start_point, end_point]
        if haversine_meters(start_point, end_point) >= 1.0
        else [start_point]
    )
    return [
        *points[:start_index],
        *replacement,
        *points[end_index + 1 :],
    ]


def max_deviation_from_straight_line(points: Sequence[RoutePoint]) -> float:
    if len(points) <= 2:
        return 0.0

    start = points[0]
    end = points[-1]
    return max(
        point_to_segment_distance_meters(point, start, end)
        for point in points[1:-1]
    )


def max_pair_distance_meters(points: Sequence[RoutePoint]) -> float:
    max_distance = 0.0
    for left_index, left in enumerate(points):
        for right in points[left_index + 1 :]:
            max_distance = max(max_distance, haversine_meters(left, right))
    return max_distance


def cumulative_turn_degrees(points: Sequence[RoutePoint]) -> float:
    total = 0.0
    previous_bearing: Optional[float] = None

    for index in range(1, len(points)):
        bearing = calculate_bearing(points[index - 1], points[index])
        if bearing is None:
            continue
        if previous_bearing is not None:
            total += heading_delta(previous_bearing, bearing) or 0.0
        previous_bearing = bearing

    return total


def build_cleanup_issue_id(
    issue_type: str,
    start_index: int,
    end_index: int,
    metrics: Dict[str, Any],
) -> str:
    return ":".join(
        [
            issue_type,
            str(start_index),
            str(end_index),
            str(int(round(float(metrics.get("pathDistanceM") or 0)))),
            str(int(round(float(metrics.get("displacementM") or 0)))),
            str(int(round(float(metrics.get("turnDegrees") or 0)))),
        ]
    )


def build_cleanup_issue(
    issue_type: str,
    title: str,
    message: str,
    confidence: float,
    source: str,
    start_index: int,
    end_index: int,
    metrics: Dict[str, Any],
    points: Sequence[RoutePoint],
) -> Dict[str, Any]:
    return {
        "id": build_cleanup_issue_id(issue_type, start_index, end_index, metrics),
        "type": issue_type,
        "title": title,
        "message": message,
        "confidence": round(clamp(confidence, 0.0, 0.99), 3),
        "source": source,
        "status": "pending",
        "affectedPointIndexes": [start_index, end_index],
        "metrics": metrics,
        "proposedGeometry": points_to_line_string(
            replace_window_with_straight_segment(points, start_index, end_index)
        ),
    }


def ranges_substantially_overlap(
    left: Tuple[int, int], right: Tuple[int, int]
) -> bool:
    overlap_start = max(left[0], right[0])
    overlap_end = min(left[1], right[1])
    overlap_length = max(0, overlap_end - overlap_start + 1)
    left_length = left[1] - left[0] + 1
    right_length = right[1] - right[0] + 1
    return overlap_length / max(1, min(left_length, right_length)) >= 0.65


def dedupe_cleanup_issues(
    issues: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    ordered = sorted(
        issues,
        key=lambda issue: (
            -float(issue.get("confidence") or 0.0),
            int((issue.get("affectedPointIndexes") or [0, 0])[0]),
        ),
    )
    deduped: List[Dict[str, Any]] = []
    for issue in ordered:
        affected = issue.get("affectedPointIndexes") or [0, 0]
        current_range = (int(affected[0]), int(affected[1]))
        if any(
            existing.get("type") == issue.get("type")
            and ranges_substantially_overlap(
                (
                    int((existing.get("affectedPointIndexes") or [0, 0])[0]),
                    int((existing.get("affectedPointIndexes") or [0, 0])[1]),
                ),
                current_range,
            )
            for existing in deduped
        ):
            continue
        deduped.append(issue)

    return sorted(
        deduped,
        key=lambda issue: int((issue.get("affectedPointIndexes") or [0, 0])[0]),
    )


def detect_circular_jitter_issues(
    points: Sequence[RoutePoint], source: str
) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    max_window_size = min(len(points), 12)

    for window_size in range(5, max_window_size + 1):
        for start_index in range(0, len(points) - window_size + 1):
            end_index = start_index + window_size - 1
            window_points = list(points[start_index : end_index + 1])
            path_distance_m = float(path_distance_meters(window_points))
            displacement_m = haversine_meters(window_points[0], window_points[-1])
            diameter_m = max_pair_distance_meters(window_points)
            turn_degrees = cumulative_turn_degrees(window_points)
            max_deviation_m = max_deviation_from_straight_line(window_points)
            loopiness_ratio = path_distance_m / max(displacement_m, 1.0)

            if path_distance_m < 14.0 or displacement_m < 2.5:
                continue
            if loopiness_ratio < 2.2 or displacement_m > min(12.0, path_distance_m * 0.42):
                continue
            if diameter_m > 26.0 or turn_degrees < 255.0 or max_deviation_m < 3.0:
                continue

            confidence = (
                0.64
                + min(0.18, (turn_degrees - 255.0) / 360.0)
                + min(0.12, (loopiness_ratio - 2.2) * 0.08)
                - min(0.12, diameter_m / 260.0)
            )

            issues.append(
                build_cleanup_issue(
                    "circular_jitter",
                    "Circular GPS jitter detected",
                    "This stretch loops in a tight circle and should be straightened before approval.",
                    confidence,
                    source,
                    start_index,
                    end_index,
                    {
                        "pathDistanceM": int(round(path_distance_m)),
                        "displacementM": int(round(displacement_m)),
                        "diameterM": int(round(diameter_m)),
                        "turnDegrees": int(round(turn_degrees)),
                        "maxDeviationM": int(round(max_deviation_m)),
                    },
                    points,
                )
            )

    return issues


def detect_duplicate_overlap_issues(
    points: Sequence[RoutePoint], source: str
) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    max_window_size = min(len(points), 13)

    for window_size in range(5, max_window_size + 1):
        for start_index in range(0, len(points) - window_size + 1):
            end_index = start_index + window_size - 1
            window_points = list(points[start_index : end_index + 1])
            path_distance_m = float(path_distance_meters(window_points))
            displacement_m = haversine_meters(window_points[0], window_points[-1])
            max_deviation_m = max_deviation_from_straight_line(window_points)
            turn_degrees = cumulative_turn_degrees(window_points)
            corridor_ratio = path_distance_m / max(displacement_m, 1.0)

            if path_distance_m < 18.0 or displacement_m < 8.0:
                continue
            if corridor_ratio < 1.38 or corridor_ratio > 2.9:
                continue
            if max_deviation_m > 8.5 or turn_degrees > 250.0 or turn_degrees < 35.0:
                continue

            confidence = (
                0.58
                + min(0.16, (corridor_ratio - 1.38) * 0.22)
                + min(0.12, max(0.0, 8.5 - max_deviation_m) / 28.0)
                - min(0.10, turn_degrees / 420.0)
            )

            issues.append(
                build_cleanup_issue(
                    "duplicate_overlap",
                    "Duplicated path overlap detected",
                    "This section appears to double over the same corridor and should be simplified to a single cleaner path.",
                    confidence,
                    source,
                    start_index,
                    end_index,
                    {
                        "pathDistanceM": int(round(path_distance_m)),
                        "displacementM": int(round(displacement_m)),
                        "corridorRatio": round(corridor_ratio, 2),
                        "turnDegrees": int(round(turn_degrees)),
                        "maxDeviationM": int(round(max_deviation_m)),
                    },
                    points,
                )
            )

    return issues


def analyze_geometry_cleanup(
    points: Sequence[RoutePoint], source: str = "worker"
) -> Dict[str, Any]:
    if len(points) < 5:
        return {
            "source": source,
            "originalGeometry": None,
            "proposedGeometry": None,
            "issues": [],
            "updatedAt": utc_now_iso(),
        }

    issues = dedupe_cleanup_issues(
        [
            *detect_circular_jitter_issues(points, source),
            *detect_duplicate_overlap_issues(points, source),
        ]
    )

    return {
        "source": source,
        "originalGeometry": None,
        "proposedGeometry": issues[0]["proposedGeometry"] if len(issues) == 1 else None,
        "issues": issues,
        "updatedAt": utc_now_iso(),
    }


@dataclass
class WorkerConfig:
    server_url: str
    worker_token: str
    worker_id: str
    campus_id: Optional[str]
    claim_limit: int
    lease_seconds: int
    request_timeout_seconds: float
    idle_seconds: float
    loop: bool
    max_point_accuracy_m: float
    simplify_threshold_m: float
    min_points: int
    min_segment_points: int
    min_route_distance_m: float
    edge_match_threshold_m: float
    edge_match_accuracy_bias_m: float
    edge_match_heading_tolerance_deg: float
    max_reported_speed_mps: float
    max_jump_speed_mps: float
    max_acceleration_mps2: float
    pause_split_seconds: int
    stationary_radius_m: float
    stationary_min_duration_s: int
    graph_match_min_coverage_ratio: float
    min_candidate_support: int
    min_off_graph_gap_distance_m: float
    min_off_graph_support: int
    endpoint_snap_threshold_m: float
    popularity_unit: float
    max_popularity_boost: float
    congestion_unit: float
    max_congestion_penalty: float
    popularity_decay_hours: float
    congestion_decay_minutes: float

    @property
    def worker_api_base(self) -> str:
        return f"{self.server_url.rstrip('/')}/api/v1/analytics/worker"

    @property
    def public_api_base(self) -> str:
        return f"{self.server_url.rstrip('/')}/api/v1"


@dataclass
class TelemetryPoint:
    latitude: float
    longitude: float
    accuracy_m: float
    timestamp_ms: int
    heading_deg: Optional[float] = None
    speed_mps: Optional[float] = None

    def as_route_point(self) -> RoutePoint:
        return (self.latitude, self.longitude)

    def day_key(self) -> str:
        return datetime.fromtimestamp(self.timestamp_ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")


@dataclass
class TelemetryBatch:
    batch_id: str
    campus_id: str
    device_id: str
    session_id: str
    source: str
    points: List[TelemetryPoint]
    point_count: int
    started_at_ms: int
    ended_at_ms: int


@dataclass
class PointEdgeMatch:
    edge_id: str
    distance_m: float
    heading_delta_deg: Optional[float]
    score: float


@dataclass
class RoutingEdge:
    edge_id: str
    points: List[RoutePoint]
    base_distance_m: int
    from_node_id: str
    to_node_id: str
    accessible: bool


@dataclass
class RoutingGraph:
    edges: List[RoutingEdge]
    edge_map: Dict[str, RoutingEdge]
    adjacency: Dict[str, Set[str]]
    node_coordinates: Dict[str, RoutePoint]


@dataclass
class OffGraphGap:
    points: List[RoutePoint]
    distance_m: int
    start_edge_id: Optional[str]
    end_edge_id: Optional[str]
    start_node_id: Optional[str]
    end_node_id: Optional[str]
    start_snap_distance_m: int
    end_snap_distance_m: int
    analytics_key: str


@dataclass
class BuildingPolygon:
    building_id: str
    name: str
    polygons: List[List[List[RoutePoint]]]


@dataclass
class MatchedPath:
    edge_ids: List[str] = field(default_factory=list)
    edge_sequence_signature: str = ""
    graph_points: List[RoutePoint] = field(default_factory=list)
    graph_coverage_ratio: float = 0.0
    average_match_distance_m: int = 0
    average_match_confidence: float = 0.0
    matched_distance_m: int = 0
    unmatched_distance_m: int = 0
    start_edge_id: Optional[str] = None
    end_edge_id: Optional[str] = None
    start_node_id: Optional[str] = None
    end_node_id: Optional[str] = None


@dataclass
class PreparedSegment:
    segment_id: str
    batch: TelemetryBatch
    raw_points: List[TelemetryPoint]
    cleaned_points: List[TelemetryPoint]
    smoothed_points: List[TelemetryPoint]
    points: List[RoutePoint]
    duration_s: int
    average_accuracy_m: int
    distance_m: int
    route_signature: str
    quality_score: float
    quality_flags: List[str] = field(default_factory=list)
    discarded_point_count: int = 0
    discarded_jump_count: int = 0
    stationary_cluster_count: int = 0
    matched_path: Optional[MatchedPath] = None
    off_graph_gap: Optional[OffGraphGap] = None
    improvement_distance_m: int = 0


@dataclass
class PreparedBatch:
    batch: TelemetryBatch
    raw_points: List[TelemetryPoint]
    cleaned_points: List[TelemetryPoint]
    segments: List[PreparedSegment]
    average_accuracy_m: int
    quality_score: float
    quality_flags: List[str] = field(default_factory=list)
    discarded_point_count: int = 0
    discarded_jump_count: int = 0
    stationary_cluster_count: int = 0
    discard_reason: Optional[str] = None


@dataclass
class CandidateCluster:
    analytics_key: str
    points: List[RoutePoint]
    batch_ids: List[str] = field(default_factory=list)
    session_ids: List[str] = field(default_factory=list)
    device_ids: List[str] = field(default_factory=list)
    day_keys: List[str] = field(default_factory=list)
    distances_m: List[int] = field(default_factory=list)
    durations_s: List[int] = field(default_factory=list)
    average_accuracies_m: List[int] = field(default_factory=list)
    quality_scores: List[float] = field(default_factory=list)
    graph_coverages: List[float] = field(default_factory=list)
    match_confidences: List[float] = field(default_factory=list)
    match_distances_m: List[int] = field(default_factory=list)
    improvement_distances_m: List[int] = field(default_factory=list)
    route_signatures: Set[str] = field(default_factory=set)
    edge_sequence_signatures: Set[str] = field(default_factory=set)
    start_edge_ids: Set[str] = field(default_factory=set)
    end_edge_ids: Set[str] = field(default_factory=set)
    start_node_ids: Set[str] = field(default_factory=set)
    end_node_ids: Set[str] = field(default_factory=set)
    start_snap_distances_m: List[int] = field(default_factory=list)
    end_snap_distances_m: List[int] = field(default_factory=list)

    def add_segment(self, segment: PreparedSegment) -> None:
        gap = segment.off_graph_gap
        if gap is None:
            return

        if len(segment.points) > len(self.points):
            self.points = gap.points

        self.batch_ids.append(segment.batch.batch_id)
        self.session_ids.append(segment.batch.session_id)
        self.device_ids.append(segment.batch.device_id)
        self.day_keys.extend(point.day_key() for point in segment.cleaned_points)
        self.distances_m.append(segment.distance_m)
        self.durations_s.append(segment.duration_s)
        self.average_accuracies_m.append(segment.average_accuracy_m)
        self.quality_scores.append(segment.quality_score)
        self.graph_coverages.append(segment.matched_path.graph_coverage_ratio if segment.matched_path else 0.0)
        self.match_confidences.append(segment.matched_path.average_match_confidence if segment.matched_path else 0.0)
        self.match_distances_m.append(segment.matched_path.average_match_distance_m if segment.matched_path else 0)
        self.improvement_distances_m.append(segment.improvement_distance_m)
        self.route_signatures.add(segment.route_signature)
        if segment.matched_path and segment.matched_path.edge_sequence_signature:
            self.edge_sequence_signatures.add(segment.matched_path.edge_sequence_signature)
        if gap.start_edge_id:
            self.start_edge_ids.add(gap.start_edge_id)
        if gap.end_edge_id:
            self.end_edge_ids.add(gap.end_edge_id)
        if gap.start_node_id:
            self.start_node_ids.add(gap.start_node_id)
        if gap.end_node_id:
            self.end_node_ids.add(gap.end_node_id)
        self.start_snap_distances_m.append(gap.start_snap_distance_m)
        self.end_snap_distances_m.append(gap.end_snap_distance_m)


class ApiClient:
    def __init__(self, config: WorkerConfig) -> None:
        self.config = config

    def _json_request(
        self,
        method: str,
        url: str,
        payload: Optional[Dict[str, Any]] = None,
        authenticated: bool = True,
    ) -> Dict[str, Any]:
        data = None
        headers = {"Content-Type": "application/json"}

        if authenticated:
            headers["Authorization"] = f"Bearer {self.config.worker_token}"
            headers["x-analytics-worker-id"] = self.config.worker_id

        if payload is not None:
            data = json.dumps(payload).encode("utf-8")

        req = request.Request(url, data=data, headers=headers, method=method.upper())

        try:
            with request.urlopen(req, timeout=self.config.request_timeout_seconds) as response:
                body = response.read().decode("utf-8")
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                payload_json = json.loads(body)
                message = payload_json.get("error") or payload_json.get("message") or body
            except json.JSONDecodeError:
                message = body or str(exc)
            raise RuntimeError(message) from exc
        except error.URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

        try:
            payload_json = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Server returned a non-JSON response.") from exc

        if not payload_json.get("success"):
            raise RuntimeError(payload_json.get("error") or "Request failed.")

        return payload_json.get("data") or {}

    def claim_batches(self) -> List[Dict[str, Any]]:
        data = self._json_request(
            "POST",
            f"{self.config.worker_api_base}/telemetry/claim",
            {
                "campusId": self.config.campus_id,
                "limit": self.config.claim_limit,
                "leaseSeconds": self.config.lease_seconds,
            },
        )
        return list(data.get("items") or [])

    def complete_batch(self, batch_id: str, status: str, metadata: Dict[str, Any]) -> None:
        self._json_request(
            "POST",
            f"{self.config.worker_api_base}/telemetry/{batch_id}/complete",
            {
                "status": status,
                "metadata": metadata,
            },
        )

    def upsert_candidates(self, candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not candidates:
            return {"items": [], "createdCount": 0, "updatedCount": 0}

        return self._json_request(
            "POST",
            f"{self.config.worker_api_base}/candidates/upsert",
            {"candidates": candidates},
        )

    def upsert_overlay(self, campus_id: str, edges: List[Dict[str, Any]], metadata: Dict[str, Any]) -> None:
        if not edges:
            return

        self._json_request(
            "POST",
            f"{self.config.worker_api_base}/routing-weights",
            {
                "campusId": campus_id,
                "edges": edges,
                "metadata": metadata,
            },
        )

    def log_run_summary(self, payload: Dict[str, Any]) -> None:
        self._json_request(
            "POST",
            f"{self.config.worker_api_base}/runs/summary",
            payload,
        )

    def fetch_routing_dataset(self) -> Dict[str, Any]:
        return self._json_request(
            "GET",
            f"{self.config.public_api_base}/map/routing",
            authenticated=False,
        )

    def fetch_locations_dataset(self) -> Dict[str, Any]:
        return self._json_request(
            "GET",
            f"{self.config.public_api_base}/map/geojson",
            authenticated=False,
        )

    def fetch_routing_weights(self, campus_id: Optional[str]) -> Dict[str, Any]:
        campus_query = f"?campusId={parse.quote(campus_id or '')}" if campus_id else ""
        return self._json_request(
            "GET",
            f"{self.config.public_api_base}/map/routing-weights{campus_query}",
            authenticated=False,
        )


def weighted_route_point(points: Sequence[TelemetryPoint]) -> RoutePoint:
    if not points:
        return (0.0, 0.0)

    total_weight = 0.0
    latitude_total = 0.0
    longitude_total = 0.0
    for point in points:
        weight = 1.0 / max(1.0, point.accuracy_m) ** 2
        total_weight += weight
        latitude_total += point.latitude * weight
        longitude_total += point.longitude * weight

    if total_weight <= 0:
        return points[-1].as_route_point()

    return (latitude_total / total_weight, longitude_total / total_weight)


def representative_stationary_point(points: Sequence[TelemetryPoint]) -> TelemetryPoint:
    if not points:
        raise ValueError("Stationary cluster cannot be empty.")

    latitude, longitude = weighted_route_point(points)
    best_accuracy = min(point.accuracy_m for point in points)
    heading_values = [point.heading_deg for point in points if point.heading_deg is not None]
    speed_values = [point.speed_mps for point in points if point.speed_mps is not None]
    midpoint_index = len(points) // 2
    timestamp_ms = points[midpoint_index].timestamp_ms

    return TelemetryPoint(
        latitude=latitude,
        longitude=longitude,
        accuracy_m=best_accuracy,
        heading_deg=average(heading_values) if heading_values else None,
        speed_mps=min(speed_values) if speed_values else 0.0,
        timestamp_ms=timestamp_ms,
    )


def smooth_telemetry_points(points: Sequence[TelemetryPoint]) -> List[TelemetryPoint]:
    if len(points) <= 2:
        return list(points)

    smoothed: List[TelemetryPoint] = [points[0]]
    for index in range(1, len(points) - 1):
        window = points[index - 1 : index + 2]
        latitude, longitude = weighted_route_point(window)
        heading_values = [point.heading_deg for point in window if point.heading_deg is not None]
        speed_values = [point.speed_mps for point in window if point.speed_mps is not None]
        smoothed.append(
            TelemetryPoint(
                latitude=latitude,
                longitude=longitude,
                accuracy_m=min(point.accuracy_m for point in window),
                heading_deg=average(heading_values) if heading_values else points[index].heading_deg,
                speed_mps=average(speed_values) if speed_values else points[index].speed_mps,
                timestamp_ms=points[index].timestamp_ms,
            )
        )
    smoothed.append(points[-1])
    return smoothed


def parse_batch(record: Dict[str, Any]) -> TelemetryBatch:
    points: List[TelemetryPoint] = []
    for raw_point in record.get("points") or []:
        try:
            points.append(
                TelemetryPoint(
                    latitude=float(raw_point["latitude"]),
                    longitude=float(raw_point["longitude"]),
                    accuracy_m=float(raw_point.get("accuracyM", raw_point.get("accuracy_m", 0.0))),
                    heading_deg=normalize_heading(
                        float(raw_point["headingDeg"])
                    )
                    if raw_point.get("headingDeg") is not None
                    else normalize_heading(float(raw_point["heading_deg"]))
                    if raw_point.get("heading_deg") is not None
                    else None,
                    speed_mps=float(raw_point["speedMps"])
                    if raw_point.get("speedMps") is not None
                    else float(raw_point["speed_mps"])
                    if raw_point.get("speed_mps") is not None
                    else None,
                    timestamp_ms=int(raw_point.get("timestampMs", raw_point.get("timestamp_ms", 0))),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue

    points.sort(key=lambda point: point.timestamp_ms)

    return TelemetryBatch(
        batch_id=str(record["id"]),
        campus_id=str(record["campusId"]),
        device_id=str(record.get("deviceId") or ""),
        session_id=str(record.get("sessionId") or ""),
        source=str(record.get("source") or "web_client"),
        points=points,
        point_count=int(record.get("pointCount") or len(points)),
        started_at_ms=int(record.get("startedAtMs") or (points[0].timestamp_ms if points else 0)),
        ended_at_ms=int(record.get("endedAtMs") or (points[-1].timestamp_ms if points else 0)),
    )


def build_route_signature(points: Sequence[RoutePoint]) -> str:
    if len(points) < 2:
        return "invalid"

    canonical_points = canonicalize_points(points)
    sample_indexes = sorted(
        {0, len(canonical_points) // 3, (2 * len(canonical_points)) // 3, len(canonical_points) - 1}
    )
    payload = {
        "start": quantize_point(canonical_points[0]),
        "end": quantize_point(canonical_points[-1]),
        "samples": [quantize_point(canonical_points[index]) for index in sample_indexes],
        "distanceBucketM": int(round(path_distance_meters(canonical_points) / 10.0) * 10),
    }
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()[:16]


def build_edge_sequence_signature(edge_ids: Sequence[str]) -> str:
    if not edge_ids:
        return "no_edges"
    encoded = json.dumps(list(edge_ids), separators=(",", ":"), sort_keys=False).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()[:20]


def build_stable_key(kind: str, campus_id: str, payload: Dict[str, Any]) -> str:
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return f"{campus_id}:{kind}:{hashlib.sha1(encoded).hexdigest()[:20]}"


def endpoint_node_key(point: RoutePoint) -> str:
    latitude, longitude = quantize_point(point, 5)
    return f"pt:{latitude}:{longitude}"


def read_trimmed_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def boolish_building(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    normalized = read_trimmed_string(value).lower()
    if normalized in {"", "no", "false", "0", "none"}:
        return False
    return bool(normalized)


def coordinate_to_route_point(value: Any) -> Optional[RoutePoint]:
    if not isinstance(value, list) or len(value) < 2:
        return None
    try:
        longitude = float(value[0])
        latitude = float(value[1])
    except (TypeError, ValueError):
        return None
    return (latitude, longitude)


def looks_like_building_feature(feature: Dict[str, Any]) -> bool:
    geometry = feature.get("geometry") or {}
    if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return False

    properties = feature.get("properties") or {}
    type_value = " ".join(
        filter(
            None,
            [
                read_trimmed_string(properties.get("type")),
                read_trimmed_string(properties.get("building_type")),
                read_trimmed_string(properties.get("buildingType")),
                read_trimmed_string(properties.get("category")),
            ],
        )
    ).lower()

    return bool(
        boolish_building(properties.get("building"))
        or read_trimmed_string(properties.get("building_id"))
        or "building" in type_value
    )


def parse_polygon_rings(raw_polygon: Any) -> List[List[RoutePoint]]:
    if not isinstance(raw_polygon, list):
        return []
    rings: List[List[RoutePoint]] = []
    for raw_ring in raw_polygon:
        if not isinstance(raw_ring, list):
            continue
        ring_points = [point for point in (coordinate_to_route_point(item) for item in raw_ring) if point]
        if len(ring_points) >= 3:
            rings.append(ring_points)
    return rings


def parse_building_polygons(dataset_payload: Dict[str, Any]) -> List[BuildingPolygon]:
    collection = dataset_payload.get("collection") or {}
    buildings: List[BuildingPolygon] = []

    for index, feature in enumerate(collection.get("features") or []):
        if not isinstance(feature, dict) or not looks_like_building_feature(feature):
            continue

        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        feature_id = read_trimmed_string(feature.get("id"))
        building_id = (
            read_trimmed_string(properties.get("building_id"))
            or read_trimmed_string(properties.get("id"))
            or feature_id
            or f"building_{index}"
        )
        name = read_trimmed_string(properties.get("name")) or building_id

        polygons: List[List[List[RoutePoint]]] = []
        if geometry.get("type") == "Polygon":
            rings = parse_polygon_rings(geometry.get("coordinates"))
            if rings:
                polygons.append(rings)
        elif geometry.get("type") == "MultiPolygon":
            for raw_polygon in geometry.get("coordinates") or []:
                rings = parse_polygon_rings(raw_polygon)
                if rings:
                    polygons.append(rings)

        if polygons:
            buildings.append(
                BuildingPolygon(
                    building_id=building_id,
                    name=name,
                    polygons=polygons,
                )
            )

    return buildings


def point_in_ring(point: RoutePoint, ring: Sequence[RoutePoint]) -> bool:
    inside = False
    point_x = point[1]
    point_y = point[0]

    for index in range(len(ring)):
        current = ring[index]
        previous = ring[index - 1]
        current_x = current[1]
        current_y = current[0]
        previous_x = previous[1]
        previous_y = previous[0]
        intersects = (
            (current_y > point_y) != (previous_y > point_y)
            and point_x
            < ((previous_x - current_x) * (point_y - current_y)) / ((previous_y - current_y) or 1e-12) + current_x
        )
        if intersects:
            inside = not inside

    return inside


def point_in_polygon(point: RoutePoint, polygon: Sequence[Sequence[RoutePoint]]) -> bool:
    if not polygon or not point_in_ring(point, polygon[0]):
        return False

    for inner_ring in polygon[1:]:
        if point_in_ring(point, inner_ring):
            return False

    return True


def point_in_building(point: RoutePoint, building: BuildingPolygon) -> bool:
    return any(point_in_polygon(point, polygon) for polygon in building.polygons)


def orientation(a: RoutePoint, b: RoutePoint, c: RoutePoint) -> float:
    return (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])


def on_segment(a: RoutePoint, b: RoutePoint, c: RoutePoint) -> bool:
    return (
        min(a[1], c[1]) - 1e-12 <= b[1] <= max(a[1], c[1]) + 1e-12
        and min(a[0], c[0]) - 1e-12 <= b[0] <= max(a[0], c[0]) + 1e-12
    )


def segments_intersect(start_a: RoutePoint, end_a: RoutePoint, start_b: RoutePoint, end_b: RoutePoint) -> bool:
    o1 = orientation(start_a, end_a, start_b)
    o2 = orientation(start_a, end_a, end_b)
    o3 = orientation(start_b, end_b, start_a)
    o4 = orientation(start_b, end_b, end_a)

    if (o1 > 0 > o2 or o1 < 0 < o2) and (o3 > 0 > o4 or o3 < 0 < o4):
        return True

    if abs(o1) <= 1e-12 and on_segment(start_a, start_b, end_a):
        return True
    if abs(o2) <= 1e-12 and on_segment(start_a, end_b, end_a):
        return True
    if abs(o3) <= 1e-12 and on_segment(start_b, start_a, end_b):
        return True
    if abs(o4) <= 1e-12 and on_segment(start_b, end_a, end_b):
        return True

    return False


def segment_intersects_ring(start: RoutePoint, end: RoutePoint, ring: Sequence[RoutePoint]) -> bool:
    if len(ring) < 2:
        return False
    for index in range(len(ring)):
        ring_start = ring[index]
        ring_end = ring[(index + 1) % len(ring)]
        if segments_intersect(start, end, ring_start, ring_end):
            return True
    return False


def segment_intersects_polygon(start: RoutePoint, end: RoutePoint, polygon: Sequence[Sequence[RoutePoint]]) -> bool:
    if point_in_polygon(start, polygon) or point_in_polygon(end, polygon):
        return True

    midpoint = ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
    if point_in_polygon(midpoint, polygon):
        return True

    outer_ring = polygon[0] if polygon else []
    if segment_intersects_ring(start, end, outer_ring):
        return True

    for inner_ring in polygon[1:]:
        if segment_intersects_ring(start, end, inner_ring):
            return True

    return False


def analyze_building_crossings(points: Sequence[RoutePoint], buildings: Sequence[BuildingPolygon]) -> List[Dict[str, Any]]:
    if len(points) < 2 or not buildings:
        return []

    details: List[Dict[str, Any]] = []
    for building in buildings:
        inside_distance_m = 0.0
        intersection_count = 0

        for index in range(1, len(points)):
            start = points[index - 1]
            end = points[index]
            segment_distance_m = haversine_meters(start, end)
            intersects = any(segment_intersects_polygon(start, end, polygon) for polygon in building.polygons)
            if intersects:
                intersection_count += 1
                inside_distance_m += segment_distance_m
                continue

            midpoint = ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
            if point_in_building(midpoint, building):
                inside_distance_m += segment_distance_m

        if inside_distance_m >= 6.0 or intersection_count > 0:
            details.append(
                {
                    "buildingId": building.building_id,
                    "name": building.name,
                    "intersectionCount": intersection_count,
                    "insideDistanceM": int(round(inside_distance_m)),
                }
            )

    return details


def parse_routing_graph(dataset_payload: Dict[str, Any]) -> RoutingGraph:
    collection = dataset_payload.get("collection") or {}
    edges: List[RoutingEdge] = []
    edge_map: Dict[str, RoutingEdge] = {}
    adjacency: Dict[str, Set[str]] = {}
    node_coordinates: Dict[str, RoutePoint] = {}

    for feature in collection.get("features") or []:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString":
            continue

        coordinates = geometry.get("coordinates") or []
        route_points: List[RoutePoint] = []
        for coordinate in coordinates:
            if not isinstance(coordinate, list) or len(coordinate) < 2:
                continue
            try:
                route_points.append((float(coordinate[1]), float(coordinate[0])))
            except (TypeError, ValueError):
                continue

        if len(route_points) < 2:
            continue

        properties = feature.get("properties") or {}
        edge_id = str(feature.get("id") or properties.get("edge_id") or "").strip()
        if not edge_id:
            continue

        from_node_id = str(properties.get("from") or "").strip() or endpoint_node_key(route_points[0])
        to_node_id = str(properties.get("to") or "").strip() or endpoint_node_key(route_points[-1])
        accessible = bool(properties.get("accessible", True))

        edge = RoutingEdge(
            edge_id=edge_id,
            points=route_points,
            base_distance_m=path_distance_meters(route_points),
            from_node_id=from_node_id,
            to_node_id=to_node_id,
            accessible=accessible,
        )
        edges.append(edge)
        edge_map[edge_id] = edge
        node_coordinates.setdefault(from_node_id, route_points[0])
        node_coordinates.setdefault(to_node_id, route_points[-1])

    edges_by_node: Dict[str, Set[str]] = {}
    for edge in edges:
        edges_by_node.setdefault(edge.from_node_id, set()).add(edge.edge_id)
        edges_by_node.setdefault(edge.to_node_id, set()).add(edge.edge_id)

    for edge in edges:
        neighbors = set(edges_by_node.get(edge.from_node_id, set())) | set(edges_by_node.get(edge.to_node_id, set()))
        neighbors.discard(edge.edge_id)
        adjacency[edge.edge_id] = neighbors

    return RoutingGraph(
        edges=edges,
        edge_map=edge_map,
        adjacency=adjacency,
        node_coordinates=node_coordinates,
    )


def nearest_node_on_edge(graph: RoutingGraph, edge_id: Optional[str], point: RoutePoint) -> Tuple[Optional[str], int]:
    if not edge_id or edge_id not in graph.edge_map:
        return (None, 0)

    edge = graph.edge_map[edge_id]
    start_distance = haversine_meters(point, graph.node_coordinates.get(edge.from_node_id, edge.points[0]))
    end_distance = haversine_meters(point, graph.node_coordinates.get(edge.to_node_id, edge.points[-1]))
    if start_distance <= end_distance:
        return (edge.from_node_id, int(round(start_distance)))
    return (edge.to_node_id, int(round(end_distance)))


def shortest_path_distance_m(graph: RoutingGraph, start_node_id: Optional[str], end_node_id: Optional[str]) -> Optional[int]:
    if not start_node_id or not end_node_id:
        return None
    if start_node_id == end_node_id:
        return 0

    distances: Dict[str, float] = {start_node_id: 0.0}
    heap: List[Tuple[float, str]] = [(0.0, start_node_id)]
    visited: Set[str] = set()

    edges_by_node: Dict[str, List[Tuple[str, str, int]]] = {}
    for edge in graph.edges:
        edges_by_node.setdefault(edge.from_node_id, []).append((edge.to_node_id, edge.edge_id, edge.base_distance_m))
        edges_by_node.setdefault(edge.to_node_id, []).append((edge.from_node_id, edge.edge_id, edge.base_distance_m))

    while heap:
        distance_so_far, node_id = heapq.heappop(heap)
        if node_id in visited:
            continue
        if node_id == end_node_id:
            return int(round(distance_so_far))
        visited.add(node_id)

        for neighbor_id, _edge_id, edge_distance in edges_by_node.get(node_id, []):
            next_distance = distance_so_far + edge_distance
            if next_distance < distances.get(neighbor_id, float("inf")):
                distances[neighbor_id] = next_distance
                heapq.heappush(heap, (next_distance, neighbor_id))

    return None


def build_graph_points_from_edges(edge_ids: Sequence[str], graph: RoutingGraph) -> List[RoutePoint]:
    if not edge_ids:
        return []

    route_points: List[RoutePoint] = []
    current_node_id: Optional[str] = None
    for edge_id in edge_ids:
        edge = graph.edge_map.get(edge_id)
        if edge is None:
            continue

        edge_points = list(edge.points)
        if current_node_id == edge.to_node_id:
            edge_points = list(reversed(edge_points))
            current_node_id = edge.from_node_id
        elif current_node_id == edge.from_node_id:
            current_node_id = edge.to_node_id
        else:
            current_node_id = edge.to_node_id

        if route_points and edge_points and route_points[-1] == edge_points[0]:
            route_points.extend(edge_points[1:])
        else:
            route_points.extend(edge_points)

    return route_points


def compute_batch_quality_score(
    raw_count: int,
    cleaned_count: int,
    average_accuracy_m: float,
    discarded_jump_count: int,
    segment_count: int,
    config: WorkerConfig,
) -> float:
    if raw_count <= 0:
        return 0.0

    retention_ratio = cleaned_count / max(1, raw_count)
    jump_ratio = discarded_jump_count / max(1, raw_count)
    accuracy_penalty = clamp(average_accuracy_m / max(1.0, config.max_point_accuracy_m), 0.0, 1.0) * 0.30
    retention_bonus = retention_ratio * 0.35
    jump_penalty = min(0.35, jump_ratio * 0.9)
    split_penalty = min(0.12, max(0, segment_count - 1) * 0.04)

    score = 0.35 + retention_bonus - accuracy_penalty - jump_penalty - split_penalty
    return round(clamp(score, 0.05, 0.99), 3)


def clean_batch_points(
    points: Sequence[TelemetryPoint], config: WorkerConfig
) -> Tuple[List[TelemetryPoint], int, int, int]:
    accuracy_filtered = [point for point in points if point.accuracy_m <= config.max_point_accuracy_m]
    if not accuracy_filtered:
        return ([], len(points), 0, 0)

    retained: List[TelemetryPoint] = []
    discarded_jumps = 0
    previous_speed: Optional[float] = None

    for point in accuracy_filtered:
        if not retained:
            retained.append(point)
            continue

        previous = retained[-1]
        delta_seconds = max(0.001, (point.timestamp_ms - previous.timestamp_ms) / 1000.0)
        distance_m = haversine_meters(previous.as_route_point(), point.as_route_point())
        derived_speed_mps = distance_m / delta_seconds
        reported_speed_mps = point.speed_mps if point.speed_mps is not None and point.speed_mps >= 0 else None
        effective_speed_mps = max(derived_speed_mps, reported_speed_mps or 0.0)
        acceleration_mps2 = (
            abs(effective_speed_mps - previous_speed) / delta_seconds
            if previous_speed is not None
            else 0.0
        )

        jump_threshold_m = max(config.stationary_radius_m * 2.0, point.accuracy_m + previous.accuracy_m)
        should_reject = False
        if reported_speed_mps is not None and reported_speed_mps > config.max_reported_speed_mps:
            should_reject = True
        if derived_speed_mps > config.max_jump_speed_mps and distance_m > jump_threshold_m:
            should_reject = True
        if acceleration_mps2 > config.max_acceleration_mps2 and distance_m > jump_threshold_m:
            should_reject = True

        if should_reject:
            discarded_jumps += 1
            continue

        retained.append(point)
        previous_speed = effective_speed_mps

    collapsed: List[TelemetryPoint] = []
    stationary_clusters = 0
    index = 0
    while index < len(retained):
        cluster = [retained[index]]
        cluster_start = retained[index].timestamp_ms
        next_index = index + 1
        while next_index < len(retained):
            candidate = retained[next_index]
            cluster_center = weighted_route_point(cluster)
            distance_to_cluster = haversine_meters(cluster_center, candidate.as_route_point())
            low_speed = candidate.speed_mps is not None and candidate.speed_mps <= 0.45
            if distance_to_cluster <= config.stationary_radius_m or low_speed:
                cluster.append(candidate)
                next_index += 1
                continue
            break

        cluster_duration_s = max(0.0, (cluster[-1].timestamp_ms - cluster_start) / 1000.0)
        if len(cluster) > 1 and cluster_duration_s >= config.stationary_min_duration_s:
            collapsed.append(representative_stationary_point(cluster))
            stationary_clusters += 1
        else:
            collapsed.extend(cluster)

        index = next_index

    discarded_points = len(points) - len(collapsed)
    return (collapsed, discarded_points, discarded_jumps, stationary_clusters)


def split_into_segments(points: Sequence[TelemetryPoint], config: WorkerConfig) -> List[List[TelemetryPoint]]:
    if not points:
        return []

    segments: List[List[TelemetryPoint]] = []
    current_segment: List[TelemetryPoint] = [points[0]]
    for point in points[1:]:
        previous = current_segment[-1]
        delta_seconds = max(0.0, (point.timestamp_ms - previous.timestamp_ms) / 1000.0)
        if delta_seconds >= config.pause_split_seconds:
            segments.append(current_segment)
            current_segment = [point]
            continue
        current_segment.append(point)

    if current_segment:
        segments.append(current_segment)
    return segments


def simplify_segment_points(points: Sequence[TelemetryPoint], threshold_m: float) -> List[RoutePoint]:
    route_points = [point.as_route_point() for point in points]
    return canonicalize_points(simplify_points(route_points, threshold_m))


def segment_quality_flags(
    average_accuracy_m: int,
    graph_coverage_ratio: float,
    quality_score: float,
    config: WorkerConfig,
) -> List[str]:
    flags: List[str] = []
    if average_accuracy_m >= max(12, int(round(config.max_point_accuracy_m * 0.5))):
        flags.append("low_accuracy")
    if graph_coverage_ratio < config.graph_match_min_coverage_ratio:
        flags.append("low_graph_coverage")
    if quality_score < 0.45:
        flags.append("low_quality")
    return flags


def best_edge_match(
    point: TelemetryPoint,
    graph: RoutingGraph,
    previous_edge_id: Optional[str],
    config: WorkerConfig,
) -> Optional[PointEdgeMatch]:
    dynamic_threshold_m = clamp(
        point.accuracy_m + config.edge_match_accuracy_bias_m,
        8.0,
        config.edge_match_threshold_m,
    )

    best: Optional[PointEdgeMatch] = None
    for edge in graph.edges:
        best_distance_m = dynamic_threshold_m
        best_heading_delta_deg: Optional[float] = None

        for index in range(1, len(edge.points)):
            distance_m = point_to_segment_distance_meters(
                point.as_route_point(),
                edge.points[index - 1],
                edge.points[index],
            )
            if distance_m > best_distance_m:
                continue

            segment_heading = calculate_bearing(edge.points[index - 1], edge.points[index])
            match_heading_delta = None
            if point.speed_mps is not None and point.speed_mps >= 0.5:
                match_heading_delta = axis_heading_delta(point.heading_deg, segment_heading)
                if (
                    match_heading_delta is not None
                    and match_heading_delta > config.edge_match_heading_tolerance_deg
                ):
                    continue

            best_distance_m = distance_m
            best_heading_delta_deg = match_heading_delta

        if best_distance_m >= dynamic_threshold_m:
            continue

        score = 1.0 - best_distance_m / max(1.0, dynamic_threshold_m)
        if best_heading_delta_deg is not None:
            score += max(
                0.0,
                1.0 - best_heading_delta_deg / max(1.0, config.edge_match_heading_tolerance_deg),
            ) * 0.20

        if previous_edge_id:
            if edge.edge_id == previous_edge_id:
                score += 0.30
            elif edge.edge_id in graph.adjacency.get(previous_edge_id, set()):
                score += 0.12
            else:
                score -= 0.08

        if best is None or score > best.score or (
            math.isclose(score, best.score) and best_distance_m < best.distance_m
        ):
            best = PointEdgeMatch(
                edge_id=edge.edge_id,
                distance_m=best_distance_m,
                heading_delta_deg=best_heading_delta_deg,
                score=score,
            )

    return best if best and best.score > 0.05 else None


def smooth_edge_matches(matches: Sequence[Optional[PointEdgeMatch]]) -> List[Optional[PointEdgeMatch]]:
    smoothed = list(matches)
    for index in range(1, len(smoothed) - 1):
        previous_match = smoothed[index - 1]
        current_match = smoothed[index]
        next_match = smoothed[index + 1]

        if previous_match and next_match and previous_match.edge_id == next_match.edge_id:
            if current_match is None:
                smoothed[index] = PointEdgeMatch(
                    edge_id=previous_match.edge_id,
                    distance_m=max(previous_match.distance_m, next_match.distance_m),
                    heading_delta_deg=previous_match.heading_delta_deg,
                    score=min(previous_match.score, next_match.score) * 0.9,
                )
            elif current_match.edge_id != previous_match.edge_id:
                smoothed[index] = previous_match
    return smoothed


def build_edge_sequence(matches: Sequence[Optional[PointEdgeMatch]]) -> List[str]:
    edge_ids: List[str] = []
    for match in matches:
        if match is None:
            continue
        if not edge_ids or edge_ids[-1] != match.edge_id:
            edge_ids.append(match.edge_id)
    return edge_ids


def find_longest_off_graph_gap(
    campus_id: str,
    smoothed_points: Sequence[TelemetryPoint],
    matches: Sequence[Optional[PointEdgeMatch]],
    graph: RoutingGraph,
    config: WorkerConfig,
) -> Optional[OffGraphGap]:
    if len(smoothed_points) != len(matches) or len(smoothed_points) < 2:
        return None

    best_gap: Optional[OffGraphGap] = None
    index = 0
    while index < len(matches):
        if matches[index] is not None:
            index += 1
            continue

        start_index = index
        while index < len(matches) and matches[index] is None:
            index += 1
        end_index = index - 1

        previous_match = matches[start_index - 1] if start_index > 0 else None
        next_match = matches[end_index + 1] if end_index + 1 < len(matches) else None

        if previous_match is None and next_match is None:
            continue

        slice_start = max(0, start_index - 1)
        slice_end = min(len(smoothed_points) - 1, end_index + 1)
        gap_points = [point.as_route_point() for point in smoothed_points[slice_start : slice_end + 1]]
        if len(gap_points) < 2:
            continue

        gap_distance_m = path_distance_meters(gap_points)
        if gap_distance_m < config.min_off_graph_gap_distance_m:
            continue

        start_node_id, start_snap_distance_m = nearest_node_on_edge(
            graph,
            previous_match.edge_id if previous_match else (next_match.edge_id if next_match else None),
            gap_points[0],
        )
        end_node_id, end_snap_distance_m = nearest_node_on_edge(
            graph,
            next_match.edge_id if next_match else (previous_match.edge_id if previous_match else None),
            gap_points[-1],
        )
        if (
            start_snap_distance_m > config.endpoint_snap_threshold_m
            or end_snap_distance_m > config.endpoint_snap_threshold_m
        ):
            continue

        gap_signature_payload = {
            "startEdgeId": previous_match.edge_id if previous_match else None,
            "endEdgeId": next_match.edge_id if next_match else None,
            "startNodeId": start_node_id,
            "endNodeId": end_node_id,
            "routeSignature": build_route_signature(gap_points),
            "distanceBucketM": int(round(gap_distance_m / 10.0) * 10),
        }
        analytics_key = build_stable_key("gap", campus_id, gap_signature_payload)
        candidate = OffGraphGap(
            points=canonicalize_points(gap_points),
            distance_m=gap_distance_m,
            start_edge_id=previous_match.edge_id if previous_match else None,
            end_edge_id=next_match.edge_id if next_match else None,
            start_node_id=start_node_id,
            end_node_id=end_node_id,
            start_snap_distance_m=start_snap_distance_m,
            end_snap_distance_m=end_snap_distance_m,
            analytics_key=analytics_key,
        )

        if best_gap is None or candidate.distance_m > best_gap.distance_m:
            best_gap = candidate

    return best_gap


def build_matched_path(
    campus_id: str,
    segment: PreparedSegment,
    graph: RoutingGraph,
    config: WorkerConfig,
) -> MatchedPath:
    if not graph.edges:
        return MatchedPath()

    raw_matches: List[Optional[PointEdgeMatch]] = []
    previous_edge_id: Optional[str] = None
    for point in segment.smoothed_points:
        match = best_edge_match(point, graph, previous_edge_id, config)
        raw_matches.append(match)
        previous_edge_id = match.edge_id if match else previous_edge_id

    matches = smooth_edge_matches(raw_matches)
    edge_ids = build_edge_sequence(matches)

    matched_distance_m = 0.0
    unmatched_distance_m = 0.0
    match_distances_m: List[float] = []
    match_scores: List[float] = []
    for index in range(1, len(segment.smoothed_points)):
        step_distance_m = haversine_meters(
            segment.smoothed_points[index - 1].as_route_point(),
            segment.smoothed_points[index].as_route_point(),
        )
        current_match = matches[index]
        if current_match is None:
            unmatched_distance_m += step_distance_m
            continue
        matched_distance_m += step_distance_m
        match_distances_m.append(current_match.distance_m)
        match_scores.append(current_match.score)

    total_distance_m = matched_distance_m + unmatched_distance_m
    graph_coverage_ratio = matched_distance_m / total_distance_m if total_distance_m > 0 else 0.0
    graph_points = build_graph_points_from_edges(edge_ids, graph)
    matched_path = MatchedPath(
        edge_ids=edge_ids,
        edge_sequence_signature=build_edge_sequence_signature(edge_ids),
        graph_points=graph_points,
        graph_coverage_ratio=round(graph_coverage_ratio, 3),
        average_match_distance_m=int(round(average(match_distances_m))) if match_distances_m else 0,
        average_match_confidence=round(average(match_scores), 3) if match_scores else 0.0,
        matched_distance_m=int(round(matched_distance_m)),
        unmatched_distance_m=int(round(unmatched_distance_m)),
        start_edge_id=edge_ids[0] if edge_ids else None,
        end_edge_id=edge_ids[-1] if edge_ids else None,
        start_node_id=graph.edge_map[edge_ids[0]].from_node_id if edge_ids else None,
        end_node_id=graph.edge_map[edge_ids[-1]].to_node_id if edge_ids else None,
    )

    segment.off_graph_gap = find_longest_off_graph_gap(campus_id, segment.smoothed_points, matches, graph, config)
    if (
        segment.off_graph_gap is None
        and segment.distance_m >= config.min_off_graph_gap_distance_m
        and matched_path.graph_coverage_ratio < config.graph_match_min_coverage_ratio
    ):
        start_match = best_edge_match(segment.smoothed_points[0], graph, None, config)
        end_match = best_edge_match(
            segment.smoothed_points[-1],
            graph,
            start_match.edge_id if start_match else None,
            config,
        )
        if start_match or end_match:
            gap_points = canonicalize_points(segment.points)
            start_node_id, start_snap_distance_m = nearest_node_on_edge(
                graph,
                start_match.edge_id if start_match else (end_match.edge_id if end_match else None),
                gap_points[0],
            )
            end_node_id, end_snap_distance_m = nearest_node_on_edge(
                graph,
                end_match.edge_id if end_match else (start_match.edge_id if start_match else None),
                gap_points[-1],
            )
            if (
                start_snap_distance_m <= config.endpoint_snap_threshold_m
                and end_snap_distance_m <= config.endpoint_snap_threshold_m
            ):
                fallback_payload = {
                    "startEdgeId": start_match.edge_id if start_match else None,
                    "endEdgeId": end_match.edge_id if end_match else None,
                    "startNodeId": start_node_id,
                    "endNodeId": end_node_id,
                    "routeSignature": segment.route_signature,
                    "distanceBucketM": int(round(segment.distance_m / 10.0) * 10),
                }
                segment.off_graph_gap = OffGraphGap(
                    points=gap_points,
                    distance_m=segment.distance_m,
                    start_edge_id=start_match.edge_id if start_match else None,
                    end_edge_id=end_match.edge_id if end_match else None,
                    start_node_id=start_node_id,
                    end_node_id=end_node_id,
                    start_snap_distance_m=start_snap_distance_m,
                    end_snap_distance_m=end_snap_distance_m,
                    analytics_key=build_stable_key("gap", campus_id, fallback_payload),
                )
    return matched_path


def prepare_batch(
    batch: TelemetryBatch,
    graph: RoutingGraph,
    config: WorkerConfig,
) -> Optional[PreparedBatch]:
    if len(batch.points) < config.min_points:
        return PreparedBatch(
            batch=batch,
            raw_points=list(batch.points),
            cleaned_points=[],
            segments=[],
            average_accuracy_m=0,
            quality_score=0.0,
            quality_flags=["insufficient_raw_points"],
            discard_reason="insufficient_raw_points",
        )

    cleaned_points, discarded_point_count, discarded_jump_count, stationary_cluster_count = clean_batch_points(
        batch.points,
        config,
    )
    if len(cleaned_points) < config.min_points:
        return PreparedBatch(
            batch=batch,
            raw_points=list(batch.points),
            cleaned_points=cleaned_points,
            segments=[],
            average_accuracy_m=int(round(average([point.accuracy_m for point in cleaned_points]))) if cleaned_points else 0,
            quality_score=0.0,
            quality_flags=["insufficient_clean_points"],
            discarded_point_count=discarded_point_count,
            discarded_jump_count=discarded_jump_count,
            stationary_cluster_count=stationary_cluster_count,
            discard_reason="insufficient_clean_points",
        )

    average_accuracy_m = int(round(average([point.accuracy_m for point in cleaned_points])))
    raw_segments = split_into_segments(cleaned_points, config)
    prepared_segments: List[PreparedSegment] = []

    for segment_index, raw_segment in enumerate(raw_segments):
        if len(raw_segment) < config.min_segment_points:
            continue

        smoothed_points = smooth_telemetry_points(raw_segment)
        route_points = simplify_segment_points(smoothed_points, config.simplify_threshold_m)
        if len(route_points) < 2:
            continue

        distance_m = path_distance_meters(route_points)
        if distance_m < config.min_route_distance_m:
            continue

        duration_s = max(0, int(round((raw_segment[-1].timestamp_ms - raw_segment[0].timestamp_ms) / 1000.0)))
        segment_quality_score = compute_batch_quality_score(
            raw_count=len(raw_segment),
            cleaned_count=len(smoothed_points),
            average_accuracy_m=int(round(average([point.accuracy_m for point in raw_segment]))),
            discarded_jump_count=0,
            segment_count=1,
            config=config,
        )

        prepared_segment = PreparedSegment(
            segment_id=f"{batch.batch_id}:{segment_index}",
            batch=batch,
            raw_points=list(raw_segment),
            cleaned_points=list(raw_segment),
            smoothed_points=smoothed_points,
            points=route_points,
            duration_s=duration_s,
            average_accuracy_m=int(round(average([point.accuracy_m for point in raw_segment]))),
            distance_m=distance_m,
            route_signature=build_route_signature(route_points),
            quality_score=segment_quality_score,
            discarded_point_count=0,
            discarded_jump_count=0,
            stationary_cluster_count=0,
        )
        prepared_segment.matched_path = build_matched_path(batch.campus_id, prepared_segment, graph, config)
        prepared_segment.quality_flags = segment_quality_flags(
            prepared_segment.average_accuracy_m,
            prepared_segment.matched_path.graph_coverage_ratio if prepared_segment.matched_path else 0.0,
            prepared_segment.quality_score,
            config,
        )

        if prepared_segment.off_graph_gap:
            alternative_distance_m = shortest_path_distance_m(
                graph,
                prepared_segment.off_graph_gap.start_node_id,
                prepared_segment.off_graph_gap.end_node_id,
            )
            if alternative_distance_m is not None:
                prepared_segment.improvement_distance_m = max(
                    0,
                    alternative_distance_m - prepared_segment.off_graph_gap.distance_m,
                )

        prepared_segments.append(prepared_segment)

    if not prepared_segments:
        return PreparedBatch(
            batch=batch,
            raw_points=list(batch.points),
            cleaned_points=cleaned_points,
            segments=[],
            average_accuracy_m=average_accuracy_m,
            quality_score=compute_batch_quality_score(
                raw_count=len(batch.points),
                cleaned_count=len(cleaned_points),
                average_accuracy_m=average_accuracy_m,
                discarded_jump_count=discarded_jump_count,
                segment_count=0,
                config=config,
            ),
            quality_flags=["no_valid_segments"],
            discarded_point_count=discarded_point_count,
            discarded_jump_count=discarded_jump_count,
            stationary_cluster_count=stationary_cluster_count,
            discard_reason="no_valid_segments",
        )

    batch_quality_score = compute_batch_quality_score(
        raw_count=len(batch.points),
        cleaned_count=len(cleaned_points),
        average_accuracy_m=average_accuracy_m,
        discarded_jump_count=discarded_jump_count,
        segment_count=len(prepared_segments),
        config=config,
    )
    batch_flags = []
    if batch_quality_score < 0.45:
        batch_flags.append("low_quality")
    if stationary_cluster_count > 0:
        batch_flags.append("stationary_jitter_collapsed")

    return PreparedBatch(
        batch=batch,
        raw_points=list(batch.points),
        cleaned_points=cleaned_points,
        segments=prepared_segments,
        average_accuracy_m=average_accuracy_m,
        quality_score=batch_quality_score,
        quality_flags=batch_flags,
        discarded_point_count=discarded_point_count,
        discarded_jump_count=discarded_jump_count,
        stationary_cluster_count=stationary_cluster_count,
    )


def build_candidate_payloads(
    prepared_batches: Sequence[PreparedBatch],
    run_id: str,
    buildings: Sequence[BuildingPolygon],
    config: WorkerConfig,
) -> List[Dict[str, Any]]:
    clusters: Dict[str, CandidateCluster] = {}

    for prepared_batch in prepared_batches:
        for segment in prepared_batch.segments:
            if segment.off_graph_gap is None:
                continue
            if segment.matched_path and segment.matched_path.graph_coverage_ratio >= 0.98:
                continue

            cluster = clusters.get(segment.off_graph_gap.analytics_key)
            if cluster is None:
                cluster = CandidateCluster(
                    analytics_key=segment.off_graph_gap.analytics_key,
                    points=segment.off_graph_gap.points,
                )
                clusters[segment.off_graph_gap.analytics_key] = cluster
            cluster.add_segment(segment)

    payloads: List[Dict[str, Any]] = []
    for analytics_key, cluster in clusters.items():
        observed_count = len(set(cluster.batch_ids))
        distinct_session_count = len(set(cluster.session_ids))
        distinct_device_count = len(set(filter(None, cluster.device_ids)))
        distinct_day_count = len(set(cluster.day_keys))
        if observed_count < config.min_candidate_support or distinct_session_count < config.min_off_graph_support:
            continue

        average_distance_m = int(round(average(cluster.distances_m)))
        average_duration_s = int(round(average(cluster.durations_s)))
        average_accuracy_m = int(round(average(cluster.average_accuracies_m)))
        average_quality_score = average(cluster.quality_scores)
        average_graph_coverage = average(cluster.graph_coverages)
        average_match_confidence = average(cluster.match_confidences)
        average_match_distance_m = int(round(average(cluster.match_distances_m)))
        average_start_snap_distance_m = int(round(average(cluster.start_snap_distances_m)))
        average_end_snap_distance_m = int(round(average(cluster.end_snap_distances_m)))
        improvement_distance_m = int(round(average(cluster.improvement_distances_m)))
        building_crossings = analyze_building_crossings(cluster.points, buildings)
        cleanup_metadata = analyze_geometry_cleanup(cluster.points, "worker")
        cleanup_issues = list(cleanup_metadata.get("issues") or [])
        needs_manual_edit = len(building_crossings) > 0 or len(cleanup_issues) > 0

        confidence = 0.34
        confidence += min(0.22, max(0, observed_count - 1) * 0.08)
        confidence += min(0.14, max(0, distinct_session_count - 1) * 0.05)
        confidence += min(0.10, max(0, distinct_device_count - 1) * 0.04)
        confidence += min(0.08, max(0, distinct_day_count - 1) * 0.03)
        confidence += min(0.16, average_quality_score * 0.16)
        confidence += min(0.08, average_match_confidence * 0.08)
        confidence -= min(0.14, max(0, average_accuracy_m - 8) / 100.0)
        confidence -= min(0.10, (average_start_snap_distance_m + average_end_snap_distance_m) / 200.0)
        confidence -= min(0.10, max(0.0, average_graph_coverage - 0.15) * 0.25)
        if needs_manual_edit:
            confidence -= min(0.12, 0.05 + len(building_crossings) * 0.02)
        confidence = round(clamp(confidence, 0.35, 0.99), 3)

        short_id = analytics_key.split(":")[-1][:8].upper()
        title = f"Discovered gap {short_id}"
        worker_suggestions: List[Dict[str, Any]] = []
        if needs_manual_edit:
            building_names = [detail["name"] for detail in building_crossings]
            if building_crossings:
                worker_suggestions.append(
                    {
                        "type": "building_intersection",
                        "severity": "warning",
                        "title": "Route crosses building footprints",
                        "message": (
                            f"This discovered path intersects {len(building_crossings)} building footprint(s): "
                            + ", ".join(building_names[:4])
                            + ("." if len(building_names) <= 4 else ", and more.")
                        ),
                        "action": "Edit the path around entrances, corridors, or outdoor walkways before approval.",
                        "buildingIds": [detail["buildingId"] for detail in building_crossings],
                        "buildingNames": building_names,
                    }
                )
            if cleanup_issues:
                issue_types = {str(issue.get("type") or "") for issue in cleanup_issues}
                if "duplicate_overlap" in issue_types:
                    worker_suggestions.append(
                        {
                            "type": "duplicate_overlap_cleanup",
                            "severity": "warning",
                            "title": "Duplicated overlap detected",
                            "message": "The discovered path doubles over itself in one or more sections.",
                            "action": "Review the suggested single-path cleanup before approval.",
                        }
                    )
                if "circular_jitter" in issue_types:
                    worker_suggestions.append(
                        {
                            "type": "circular_jitter_cleanup",
                            "severity": "warning",
                            "title": "Circular GPS jitter detected",
                            "message": "The discovered path contains a tight loop that looks like GPS drift.",
                            "action": "Review the suggested straightened path before approval.",
                        }
                    )
        payloads.append(
            {
                "analyticsKey": analytics_key,
                "campusId": analytics_key.split(":", 1)[0],
                "title": title,
                "points": [
                    {"latitude": latitude, "longitude": longitude}
                    for latitude, longitude in cluster.points
                ],
                "routeProperties": {
                    "name": title,
                    "accessible": True,
                    "stairs": False,
                    "ramp": False,
                    "elevator": False,
                },
                "observedCount": observed_count,
                "distinctSessionCount": distinct_session_count,
                "confidence": confidence,
                "averageDistanceM": average_distance_m,
                "averageDurationS": average_duration_s,
                "averageAccuracyM": average_accuracy_m,
                "improvementDistanceM": improvement_distance_m,
                "telemetrySourceIds": sorted(set(cluster.batch_ids)),
                "metadata": {
                    "runId": run_id,
                    "source": "python_worker",
                    "kind": "off_graph_gap",
                    "qualityScore": round(average_quality_score, 3),
                    "graphCoverageRatio": round(average_graph_coverage, 3),
                    "edgeSequenceSignatures": sorted(cluster.edge_sequence_signatures),
                    "routeSignatures": sorted(cluster.route_signatures),
                    "sessionIds": sorted(set(cluster.session_ids)),
                    "deviceIds": sorted(set(filter(None, cluster.device_ids))),
                    "dayKeys": sorted(set(cluster.day_keys)),
                    "matchConfidence": {
                        "average": round(average_match_confidence, 3),
                        "averageDistanceM": average_match_distance_m,
                    },
                    "endpointSnapScores": {
                        "startDistanceM": average_start_snap_distance_m,
                        "endDistanceM": average_end_snap_distance_m,
                    },
                    "duplicateMerge": {
                        "mergedBatchCount": observed_count,
                        "mergedRouteSignatureCount": len(cluster.route_signatures),
                    },
                    "rejectionSuppression": {
                        "analyticsKey": analytics_key,
                        "stable": True,
                    },
                    "reviewRecommendation": "edit_before_approval" if needs_manual_edit else "review",
                    "workerSuggestions": worker_suggestions,
                    "geometryCleanup": cleanup_metadata,
                    "buildingCrossings": {
                        "count": len(building_crossings),
                        "items": building_crossings,
                    },
                    "anchors": {
                        "startEdgeIds": sorted(cluster.start_edge_ids),
                        "endEdgeIds": sorted(cluster.end_edge_ids),
                        "startNodeIds": sorted(cluster.start_node_ids),
                        "endNodeIds": sorted(cluster.end_node_ids),
                    },
                },
            }
        )

    return payloads


def build_overlay_updates(
    prepared_batches: Sequence[PreparedBatch],
    graph: RoutingGraph,
    current_overlay_payload: Dict[str, Any],
    config: WorkerConfig,
) -> List[Dict[str, Any]]:
    if not graph.edges:
        return []

    current_overlay = {
        str(edge.get("edgeId")): edge
        for edge in current_overlay_payload.get("edges") or []
        if edge.get("edgeId")
    }
    traversed_counts: Dict[str, int] = {}
    for prepared_batch in prepared_batches:
        for segment in prepared_batch.segments:
            if not segment.matched_path:
                continue
            for edge_id in segment.matched_path.edge_ids:
                traversed_counts[edge_id] = traversed_counts.get(edge_id, 0) + 1

    now = datetime.now(timezone.utc)
    all_edge_ids = set(current_overlay.keys()) | set(traversed_counts.keys())
    overlay_edges: List[Dict[str, Any]] = []

    popularity_decay_seconds = max(1.0, config.popularity_decay_hours * 3600.0)
    congestion_decay_seconds = max(1.0, config.congestion_decay_minutes * 60.0)

    for edge_id in sorted(all_edge_ids):
        edge = graph.edge_map.get(edge_id)
        existing = current_overlay.get(edge_id, {})
        base_distance_m = int(existing.get("baseDistanceM") or (edge.base_distance_m if edge else 0))
        if base_distance_m <= 0:
            continue

        updated_at_raw = existing.get("updatedAt")
        updated_at = None
        if isinstance(updated_at_raw, str):
            try:
                updated_at = datetime.fromisoformat(updated_at_raw.replace("Z", "+00:00"))
            except ValueError:
                updated_at = None

        age_seconds = max(
            0.0,
            (now - updated_at).total_seconds(),
        ) if updated_at is not None else popularity_decay_seconds

        previous_popularity = float(existing.get("popularityCount7d") or 0)
        previous_congestion = float(existing.get("congestionCount15m") or 0)
        decayed_popularity = previous_popularity * math.exp(-age_seconds / popularity_decay_seconds)
        decayed_congestion = previous_congestion * math.exp(-age_seconds / congestion_decay_seconds)
        increment = traversed_counts.get(edge_id, 0)

        popularity_count_7d = int(round(decayed_popularity + increment))
        congestion_count_15m = int(round(decayed_congestion + increment))
        popularity_boost = round(
            clamp(popularity_count_7d * config.popularity_unit, 0.0, config.max_popularity_boost),
            4,
        )
        congestion_penalty = round(
            clamp(congestion_count_15m * config.congestion_unit, 0.0, config.max_congestion_penalty),
            4,
        )

        overlay_edges.append(
            {
                "edgeId": edge_id,
                "baseDistanceM": base_distance_m,
                "popularityCount7d": popularity_count_7d,
                "congestionCount15m": congestion_count_15m,
                "popularityBoost": popularity_boost,
                "congestionPenalty": congestion_penalty,
                "source": "python_worker",
            }
        )

    return overlay_edges


def summarize_batches(claimed_batches: Sequence[TelemetryBatch]) -> str:
    if not claimed_batches:
        return "No claimed telemetry batches."

    batch_count = len(claimed_batches)
    session_count = len({batch.session_id for batch in claimed_batches})
    device_count = len({batch.device_id for batch in claimed_batches})
    return (
        f"Claimed {batch_count} telemetry batch(es) across "
        f"{session_count} session(s) and {device_count} device(s)."
    )


def build_config(args: argparse.Namespace) -> WorkerConfig:
    load_default_env_files()

    server_url = args.server_url or env_string("ANALYTICS_SERVER_URL") or env_string("WIA_SERVER_URL")
    worker_token = args.worker_token or env_string("ANALYTICS_WORKER_TOKEN")
    campus_id = args.campus_id or env_string("ANALYTICS_CAMPUS_ID")

    if not server_url:
        raise SystemExit(
            "ANALYTICS_SERVER_URL or WIA_SERVER_URL is required. "
            "Set it in python_worker/.env or pass --server-url."
        )
    if not worker_token:
        raise SystemExit(
            "ANALYTICS_WORKER_TOKEN is required. "
            "Set it in python_worker/.env or pass --worker-token."
        )

    loop_env = env_bool("ANALYTICS_LOOP", False)
    loop = loop_env
    if args.once:
        loop = False
    if args.loop:
        loop = True

    return WorkerConfig(
        server_url=server_url,
        worker_token=worker_token,
        worker_id=env_string("ANALYTICS_WORKER_ID", "campus-analytics-v2") or "campus-analytics-v2",
        campus_id=campus_id,
        claim_limit=env_int("ANALYTICS_CLAIM_LIMIT", 25),
        lease_seconds=env_int("ANALYTICS_LEASE_SECONDS", 300),
        request_timeout_seconds=env_float("ANALYTICS_REQUEST_TIMEOUT_SECONDS", 30.0),
        idle_seconds=env_float("ANALYTICS_IDLE_SECONDS", 20.0),
        loop=loop,
        max_point_accuracy_m=env_float("ANALYTICS_MAX_POINT_ACCURACY_M", 45.0),
        simplify_threshold_m=env_float("ANALYTICS_SIMPLIFY_THRESHOLD_M", 3.0),
        min_points=env_int("ANALYTICS_MIN_POINTS", 4),
        min_segment_points=env_int("ANALYTICS_MIN_SEGMENT_POINTS", 4),
        min_route_distance_m=env_float("ANALYTICS_MIN_ROUTE_DISTANCE_M", 20.0),
        edge_match_threshold_m=env_float("ANALYTICS_EDGE_MATCH_THRESHOLD_M", 18.0),
        edge_match_accuracy_bias_m=env_float("ANALYTICS_EDGE_MATCH_ACCURACY_BIAS_M", 6.0),
        edge_match_heading_tolerance_deg=env_float("ANALYTICS_EDGE_MATCH_HEADING_TOLERANCE_DEG", 70.0),
        max_reported_speed_mps=env_float("ANALYTICS_MAX_REPORTED_SPEED_MPS", 5.5),
        max_jump_speed_mps=env_float("ANALYTICS_MAX_JUMP_SPEED_MPS", 4.5),
        max_acceleration_mps2=env_float("ANALYTICS_MAX_ACCELERATION_MPS2", 4.0),
        pause_split_seconds=env_int("ANALYTICS_PAUSE_SPLIT_SECONDS", 45),
        stationary_radius_m=env_float("ANALYTICS_STATIONARY_RADIUS_M", 6.0),
        stationary_min_duration_s=env_int("ANALYTICS_STATIONARY_MIN_DURATION_S", 12),
        graph_match_min_coverage_ratio=env_float("ANALYTICS_GRAPH_MATCH_MIN_COVERAGE_RATIO", 0.65),
        min_candidate_support=env_int("ANALYTICS_MIN_CANDIDATE_SUPPORT", 2),
        min_off_graph_gap_distance_m=env_float("ANALYTICS_MIN_OFF_GRAPH_GAP_DISTANCE_M", 12.0),
        min_off_graph_support=env_int("ANALYTICS_MIN_OFF_GRAPH_SUPPORT", 2),
        endpoint_snap_threshold_m=env_float("ANALYTICS_ENDPOINT_SNAP_THRESHOLD_M", 25.0),
        popularity_unit=env_float("ANALYTICS_POPULARITY_UNIT", 0.01),
        max_popularity_boost=env_float("ANALYTICS_MAX_POPULARITY_BOOST", 0.25),
        congestion_unit=env_float("ANALYTICS_CONGESTION_UNIT", 0.02),
        max_congestion_penalty=env_float("ANALYTICS_MAX_CONGESTION_PENALTY", 0.20),
        popularity_decay_hours=env_float("ANALYTICS_POPULARITY_DECAY_HOURS", 168.0),
        congestion_decay_minutes=env_float("ANALYTICS_CONGESTION_DECAY_MINUTES", 15.0),
    )


def run_once(client: ApiClient, config: WorkerConfig) -> bool:
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    claimed_payloads = client.claim_batches()
    claimed_batches = [parse_batch(record) for record in claimed_payloads]

    if not claimed_batches:
        log("No telemetry batches were available.")
        return False

    log(summarize_batches(claimed_batches))

    warnings: List[str] = []
    building_polygons: List[BuildingPolygon] = []
    try:
        routing_dataset = client.fetch_routing_dataset()
        routing_graph = parse_routing_graph(routing_dataset)
    except RuntimeError as exc:
        raise RuntimeError(f"Unable to load routing dataset for analytics matching: {exc}") from exc

    try:
        locations_dataset = client.fetch_locations_dataset()
        building_polygons = parse_building_polygons(locations_dataset)
    except RuntimeError as exc:
        warnings.append(f"Building intersection detection skipped: {exc}")
        log(warnings[-1])

    prepared_batches: List[PreparedBatch] = []
    discarded_batches: List[PreparedBatch] = []
    for batch in claimed_batches:
        prepared = prepare_batch(batch, routing_graph, config)
        if prepared is None:
            discarded_batches.append(
                PreparedBatch(
                    batch=batch,
                    raw_points=list(batch.points),
                    cleaned_points=[],
                    segments=[],
                    average_accuracy_m=0,
                    quality_score=0.0,
                    quality_flags=["prepare_failed"],
                    discard_reason="prepare_failed",
                )
            )
            continue

        if not prepared.segments:
            discarded_batches.append(prepared)
            continue
        prepared_batches.append(prepared)

    candidate_response: Dict[str, Any] = {"items": [], "createdCount": 0, "updatedCount": 0}
    overlay_edges: List[Dict[str, Any]] = []

    if prepared_batches:
        candidate_payloads = build_candidate_payloads(prepared_batches, run_id, building_polygons, config)
        if candidate_payloads:
            candidate_response = client.upsert_candidates(candidate_payloads)
            log(
                "Upserted analytics candidates: "
                f"{candidate_response.get('createdCount', 0)} created, "
                f"{candidate_response.get('updatedCount', 0)} updated."
            )

        try:
            current_overlay = client.fetch_routing_weights(config.campus_id)
            overlay_edges = build_overlay_updates(prepared_batches, routing_graph, current_overlay, config)
            if overlay_edges:
                client.upsert_overlay(
                    prepared_batches[0].batch.campus_id,
                    overlay_edges,
                    {
                        "runId": run_id,
                        "windowDays": 7,
                        "congestionWindowMinutes": 15,
                        "source": "python_worker",
                        "matchingMode": "graph_edge_sequence",
                    },
                )
                log(f"Updated routing overlay weights for {len(overlay_edges)} edge(s).")
        except RuntimeError as exc:
            warnings.append(f"Overlay sync skipped: {exc}")
            log(warnings[-1])

    processed_segment_count = 0
    for prepared in prepared_batches:
        processed_segment_count += len(prepared.segments)
        max_graph_coverage = max(
            (
                segment.matched_path.graph_coverage_ratio
                for segment in prepared.segments
                if segment.matched_path is not None
            ),
            default=0.0,
        )
        candidate_gap_count = sum(1 for segment in prepared.segments if segment.off_graph_gap is not None)
        client.complete_batch(
            prepared.batch.batch_id,
            "processed",
            {
                "runId": run_id,
                "segmentCount": len(prepared.segments),
                "qualityScore": prepared.quality_score,
                "graphCoverageRatio": round(max_graph_coverage, 3),
                "offGraphGapCount": candidate_gap_count,
                "discardedPointCount": prepared.discarded_point_count,
                "discardedJumpCount": prepared.discarded_jump_count,
                "stationaryClusterCount": prepared.stationary_cluster_count,
                "routeSignatures": [segment.route_signature for segment in prepared.segments],
                "edgeSequenceSignatures": [
                    segment.matched_path.edge_sequence_signature
                    for segment in prepared.segments
                    if segment.matched_path and segment.matched_path.edge_sequence_signature
                ],
            },
        )

    for discarded in discarded_batches:
        client.complete_batch(
            discarded.batch.batch_id,
            "discarded",
            {
                "runId": run_id,
                "reason": discarded.discard_reason or "insufficient_points_or_distance",
                "qualityFlags": discarded.quality_flags,
                "discardedPointCount": discarded.discarded_point_count,
                "discardedJumpCount": discarded.discarded_jump_count,
            },
        )

    discard_summary = summarize_discarded_batches(discarded_batches)
    if discard_summary:
        log(discard_summary)

    candidate_items = list(candidate_response.get("items") or [])
    rejected_suppressed = sum(1 for item in candidate_items if item.get("status") == "rejected")
    approved_existing = sum(1 for item in candidate_items if item.get("status") == "approved")

    client.log_run_summary(
        {
            "runId": run_id,
            "campusId": config.campus_id or (claimed_batches[0].campus_id if claimed_batches else None),
            "telemetryClaimed": len(claimed_batches),
            "telemetryProcessed": len(prepared_batches),
            "telemetryDiscarded": len(discarded_batches),
            "candidatesCreated": int(candidate_response.get("createdCount") or 0),
            "candidatesUpdated": int(candidate_response.get("updatedCount") or 0),
            "overlaysUpdated": len(overlay_edges),
            "notes": (
                f"Python analytics worker run complete. {len(warnings)} warning(s)."
                if warnings
                else "Python analytics worker run complete."
            ),
            "metadata": {
                "workerId": config.worker_id,
                "warnings": warnings,
                "processedSegmentCount": processed_segment_count,
                "candidatePayloadCount": len(candidate_items),
                "suppressedRejectedCount": rejected_suppressed,
                "alreadyApprovedCount": approved_existing,
                "buildingPolygonCount": len(building_polygons),
                "buildingIntersectionCandidateCount": sum(
                    1
                    for item in candidate_items
                    if isinstance(item.get("metadata"), dict)
                    and isinstance(item["metadata"].get("buildingCrossings"), dict)
                    and int(item["metadata"]["buildingCrossings"].get("count") or 0) > 0
                ),
                "cleanupSuggestionCandidateCount": sum(
                    1
                    for item in candidate_items
                    if isinstance(item.get("metadata"), dict)
                    and isinstance(item["metadata"].get("geometryCleanup"), dict)
                    and isinstance(item["metadata"]["geometryCleanup"].get("issues"), list)
                    and len(item["metadata"]["geometryCleanup"].get("issues") or []) > 0
                ),
                "averageBatchQuality": round(average([batch.quality_score for batch in prepared_batches]), 3)
                if prepared_batches
                else 0.0,
                "matchingMode": "graph_edge_sequence",
            },
        }
    )

    log(
        "Run complete: "
        f"{len(prepared_batches)} processed batch(es), "
        f"{len(discarded_batches)} discarded batch(es), "
        f"{processed_segment_count} segment(s)."
    )
    return True


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Process route telemetry into analytics-discovered candidates and routing overlays."
    )
    parser.add_argument(
        "--server-url",
        help="Override the server base URL instead of reading ANALYTICS_SERVER_URL.",
    )
    parser.add_argument(
        "--worker-token",
        help="Override ANALYTICS_WORKER_TOKEN for this run.",
    )
    parser.add_argument(
        "--campus-id",
        help="Override ANALYTICS_CAMPUS_ID for this run.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single claim/process/sync cycle and exit.",
    )
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Keep polling for telemetry batches until interrupted.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    config = build_config(args)
    client = ApiClient(config)

    log(
        "Starting analytics worker "
        f"'{config.worker_id}' against {config.server_url}."
    )

    try:
        if not config.loop:
            run_once(client, config)
            return 0

        while True:
            work_was_done = run_once(client, config)
            if not work_was_done:
                time.sleep(max(1.0, config.idle_seconds))
    except KeyboardInterrupt:
        log("Worker interrupted, shutting down.")
        return 0
    except RuntimeError as exc:
        log(f"Worker failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
