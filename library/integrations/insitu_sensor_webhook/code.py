import json
import math
from datetime import datetime, timezone


def _iso_utc(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("timestamp must be a non-empty ISO 8601 string")
    text = value.strip()
    parse_text = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        dt = datetime.fromisoformat(parse_text)
    except ValueError as exc:
        raise ValueError("timestamp is not valid ISO 8601") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _nonempty_text(event, field):
    value = event.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


def _finite_number(value, field):
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number")
    return number


def _coordinates(event):
    has_longitude = "longitude" in event
    has_latitude = "latitude" in event
    has_pair = "coordinates" in event

    if has_pair and (has_longitude or has_latitude):
        raise ValueError("provide coordinates or longitude/latitude, not both")
    if has_longitude != has_latitude:
        raise ValueError("longitude and latitude must be provided together")
    if not has_pair and not has_longitude:
        return None

    if has_pair:
        pair = event["coordinates"]
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError("coordinates must be [longitude, latitude]")
        lon = _finite_number(pair[0], "longitude")
        lat = _finite_number(pair[1], "latitude")
    else:
        lon = _finite_number(event["longitude"], "longitude")
        lat = _finite_number(event["latitude"], "latitude")

    if not -180 <= lon <= 180:
        raise ValueError("longitude must be between -180 and 180")
    if not -90 <= lat <= 90:
        raise ValueError("latitude must be between -90 and 90")
    return lon, lat


def _collect_events(payload, events, rejected, path="payload"):
    if isinstance(payload, list):
        for index, item in enumerate(payload):
            _collect_events(item, events, rejected, f"{path}[{index}]")
        return

    if isinstance(payload, dict) and "events" in payload:
        if set(payload.keys()) != {"events"}:
            rejected.append((path, "an events envelope may only contain the events field", payload))
            return
        if not isinstance(payload["events"], list):
            rejected.append((path, "events must be an array", payload))
            return
        for index, item in enumerate(payload["events"]):
            _collect_events(item, events, rejected, f"{path}.events[{index}]")
        return

    if isinstance(payload, dict):
        events.append((path, payload))
    else:
        rejected.append((path, "event must be a JSON object", payload))


def _event_for_log(raw):
    try:
        text = json.dumps(raw, ensure_ascii=False, default=str)
    except Exception:
        text = repr(raw)
    return text if len(text) <= 2000 else text[:2000] + "...<truncated>"


def run(ctx):
    candidates = []
    rejected = []
    _collect_events(ctx.webhook_data, candidates, rejected)
    structural_rejected_count = len(rejected)

    readings = {}
    located_events = []
    valid_event_count = 0

    for path, event in candidates:
        try:
            station_id = _nonempty_text(event, "station_id")
            variable = _nonempty_text(event, "variable")
            timestamp = _iso_utc(event.get("timestamp"))
            value = _finite_number(event.get("value"), "value")
            unit = _nonempty_text(event, "unit")
            coords = _coordinates(event)

            row = {
                "station_id": station_id,
                "variable": variable,
                "timestamp": timestamp,
                "value": value,
                "unit": unit,
            }
            readings[(station_id, variable, timestamp)] = row
            if coords is not None:
                located_events.append((station_id, timestamp, coords[0], coords[1]))
            valid_event_count += 1
        except (TypeError, ValueError) as exc:
            rejected.append((path, str(exc), event))

    previous_state = ctx.previous_state if isinstance(ctx.previous_state, dict) else {}
    previous_stations = previous_state.get("stations", {})
    if not isinstance(previous_stations, dict):
        previous_stations = {}

    # Copy only well-formed internal state. This map prevents a late, older event
    # from replacing a station location learned in a previous run.
    station_state = {}
    for station_id, item in previous_stations.items():
        if (
            isinstance(station_id, str)
            and isinstance(item, dict)
            and isinstance(item.get("timestamp"), str)
            and isinstance(item.get("longitude"), (int, float))
            and isinstance(item.get("latitude"), (int, float))
        ):
            station_state[station_id] = {
                "timestamp": item["timestamp"],
                "longitude": float(item["longitude"]),
                "latitude": float(item["latitude"]),
            }

    changed_station_ids = set()
    for station_id, timestamp, lon, lat in located_events:
        current = station_state.get(station_id)
        if current is None or timestamp >= current["timestamp"]:
            station_state[station_id] = {
                "timestamp": timestamp,
                "longitude": lon,
                "latitude": lat,
            }
            changed_station_ids.add(station_id)

    station_rows = []
    for station_id in sorted(changed_station_ids):
        item = station_state[station_id]
        station_rows.append({
            "station_id": station_id,
            "location": {
                "type": "Point",
                "coordinates": [item["longitude"], item["latitude"]],
            },
            "location_observed_at": item["timestamp"],
        })

    for path, reason, raw in rejected:
        print(f"REJECTED EVENT {path}: {reason}; event={_event_for_log(raw)}")

    rejected_count = len(rejected)
    loaded_reading_count = len(readings)
    print(
        "WEBHOOK BATCH RESULT: "
        f"received={len(candidates) + structural_rejected_count}, "
        f"valid_events={valid_event_count}, distinct_readings={loaded_reading_count}, "
        f"station_updates={len(station_rows)}, rejected={rejected_count}"
    )
    if rejected_count:
        print(f"WARNING: WEBHOOK BATCH CONTAINED {rejected_count} REJECTED EVENT(S)")

    return {
        "data": {
            "sensor_readings": list(readings.values()),
            "sensor_stations": station_rows,
        },
        "state": {
            "stations": station_state,
            "last_run": {
                "valid_event_count": valid_event_count,
                "distinct_reading_count": loaded_reading_count,
                "station_update_count": len(station_rows),
                "rejected_count": rejected_count,
            },
        },
    }
