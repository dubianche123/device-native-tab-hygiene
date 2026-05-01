#!/usr/bin/env python3
"""
Smart Tab Hygiene — Standalone Model Trainer

Trains the idle-prediction model from scratch using historical data.
Useful for bootstrapping the model before the companion app has
collected enough data.

Usage:
    python3 scripts/train_model.py [activity_events.json]

The activity events file is a JSON array of ActivityEvent objects:
    [{ "timestamp": float, "state": str, "dwellMs": float,
       "interactions": int, "tabCount": int, "category": str }, ...]

If no file is provided, the script generates synthetic training data
based on common human sleep/work patterns.

The bootstrap lookup table is saved to:
    ~/Library/Application Support/Smart Tab Hygiene/idle_lookup.json

The Swift companion reads this as a fallback until it has enough real
activity samples to train a Create ML model and load it through Core ML.
"""

import json
import sys
import os
from pathlib import Path
from datetime import datetime, timedelta
import random

APP_SUPPORT = Path.home() / "Library" / "Application Support" / "Smart Tab Hygiene"

# Categories matching extension/js/constants.js
CATEGORIES = [
    "ai", "work", "email", "reference", "social", "news",
    "shopping", "entertainment", "finance", "other",
]


def generate_synthetic_events(days: int = 90) -> list[dict]:
    """Generate synthetic activity events for bootstrapping.

    Simulates a person who:
    - Sleeps ~00:30–07:30 most days
    - Has lunch break ~12:00–13:00
    - Is mostly idle on weekends from ~11:00–18:00
    - Has some random variation (±1h on sleep, irregular weekend activity)
    - Uses varying numbers of tabs and spends different amounts of time
    """
    events = []
    base = datetime.now() - timedelta(days=days)

    for day in range(days):
        date = base + timedelta(days=day)
        weekday = date.weekday()  # 0=Mon

        # Track a simulated tab count that varies through the day
        base_tab_count = random.randint(8, 25)

        # Weekday pattern
        if weekday < 5:
            # Wake up around 7:00–8:00
            wake = 7.0 + random.gauss(0, 0.5)

            # Active: wake → 12:00 (work hours)
            for h in range(int(wake), 12):
                for _ in range(random.randint(2, 6)):
                    ts = date + timedelta(hours=h, minutes=random.randint(0, 59))
                    events.append(_make_event(
                        ts, "active",
                        tab_count=base_tab_count + random.randint(-3, 5),
                        category=random.choice(["work", "work", "email", "reference", "ai"]),
                        dwell_range=(30_000, 600_000),
                        interaction_range=(1, 12),
                    ))

            # Lunch break — emit idle event
            lunch_ts = date + timedelta(hours=12, minutes=random.randint(0, 15))
            events.append(_make_event(lunch_ts, "idle", tab_count=base_tab_count))
            if random.random() > 0.3:
                ts = date + timedelta(hours=12, minutes=random.randint(20, 59))
                events.append(_make_event(
                    ts, "active",
                    tab_count=base_tab_count,
                    category="other",
                    dwell_range=(10_000, 120_000),
                    interaction_range=(0, 3),
                ))

            # Active: 13:00–18:00
            for h in range(13, 18):
                for _ in range(random.randint(2, 6)):
                    ts = date + timedelta(hours=h, minutes=random.randint(0, 59))
                    events.append(_make_event(
                        ts, "active",
                        tab_count=base_tab_count + random.randint(-2, 8),
                        category=random.choice(["work", "work", "reference", "email", "social", "ai"]),
                        dwell_range=(30_000, 900_000),
                        interaction_range=(1, 15),
                    ))

            # Evening wind-down: 19:00–00:00
            for h in range(19, 24):
                if random.random() > 0.4:
                    ts = date + timedelta(hours=h, minutes=random.randint(0, 59))
                    events.append(_make_event(
                        ts, "active",
                        tab_count=max(3, base_tab_count - random.randint(0, 10)),
                        category=random.choice(["entertainment", "social", "news", "shopping", "ai", "other"]),
                        dwell_range=(60_000, 1_200_000),
                        interaction_range=(0, 8),
                    ))

            # Sleep — emit locked/idle events at night
            sleep_ts = date + timedelta(hours=random.randint(0, 1), minutes=random.randint(0, 30))
            events.append(_make_event(sleep_ts, "locked", tab_count=base_tab_count))

        # Weekend pattern
        else:
            # Wake up later: 9:00–11:00
            wake = 9.0 + random.gauss(0, 1.0)
            # Sporadic activity throughout the day
            for h in range(int(wake), 24):
                if random.random() > 0.5:
                    for _ in range(random.randint(1, 4)):
                        ts = date + timedelta(hours=h, minutes=random.randint(0, 59))
                        events.append(_make_event(
                            ts, "active",
                            tab_count=max(3, base_tab_count - random.randint(0, 8)),
                            category=random.choice(["entertainment", "social", "shopping", "news", "other"]),
                            dwell_range=(30_000, 1_800_000),
                            interaction_range=(0, 10),
                        ))

            # Weekend sleep — later
            sleep_ts = date + timedelta(hours=random.randint(1, 2), minutes=random.randint(0, 59))
            events.append(_make_event(sleep_ts, "locked", tab_count=base_tab_count))

    events.sort(key=lambda e: e["timestamp"])
    return events


def _make_event(
    dt: datetime,
    state: str,
    tab_count: int = 10,
    category: str = "other",
    dwell_range: tuple[int, int] = (0, 0),
    interaction_range: tuple[int, int] = (0, 0),
) -> dict:
    """Create a single ActivityEvent dict."""
    return {
        "timestamp": dt.timestamp(),
        "state": state,
        "dwellMs": float(random.randint(*dwell_range)) if state == "active" else 0.0,
        "interactions": random.randint(*interaction_range) if state == "active" else 0,
        "tabCount": max(0, tab_count),
        "category": category,
    }


def compute_idle_lookup(events: list[dict]) -> dict[str, float]:
    """Compute per (day, hour) idle probability from activity events."""
    if not events:
        return {}

    sorted_events = sorted(events, key=lambda e: e["timestamp"])
    active_timestamps = [e["timestamp"] for e in sorted_events if e.get("state") == "active"]
    if not active_timestamps:
        active_timestamps = [e["timestamp"] for e in sorted_events]

    bins: dict[str, tuple[int, int]] = {}  # key → (idle_count, total)

    # Sample every 15 minutes across the date range
    start = datetime.fromtimestamp(sorted_events[0]["timestamp"])
    end = datetime.fromtimestamp(sorted_events[-1]["timestamp"])
    gap_threshold = 30 * 60  # 30 minutes

    current = start
    while current <= end:
        day = current.weekday()  # 0=Mon (we'll convert to 0=Sun for the model)
        day_sun = (day + 1) % 7  # 0=Sun
        hour = current.hour
        ts = current.timestamp()

        # Find nearest active event
        nearest_gap = min(abs(t - ts) for t in active_timestamps)

        # Also check if there's an explicit idle/locked event nearby
        nearby_idle = any(
            abs(e["timestamp"] - ts) < gap_threshold and e.get("state") in ("idle", "locked")
            for e in sorted_events
            if abs(e["timestamp"] - ts) < gap_threshold * 2
        )
        is_idle = nearest_gap > gap_threshold or nearby_idle

        key = f"{day_sun}_{hour}"
        idle_count, total = bins.get(key, (0, 0))
        bins[key] = (idle_count + (1 if is_idle else 0), total + 1)

        current += timedelta(minutes=15)

    return {
        key: idle_count / total if total > 0 else 0.5
        for key, (idle_count, total) in bins.items()
    }


def main():
    APP_SUPPORT.mkdir(parents=True, exist_ok=True)
    lookup_path = APP_SUPPORT / "idle_lookup.json"
    events_path = APP_SUPPORT / "activity_events.json"

    if len(sys.argv) > 1:
        input_path = Path(sys.argv[1])
        print(f"Loading activity data from {input_path}...")
        with open(input_path) as f:
            raw = json.load(f)

        # Support both legacy (list of timestamps) and new (list of event objects)
        if raw and isinstance(raw[0], (int, float)):
            print(f"  Converting {len(raw)} legacy timestamps to ActivityEvent format...")
            events = [
                {"timestamp": ts, "state": "active", "dwellMs": 0.0,
                 "interactions": 0, "tabCount": 0, "category": "other"}
                for ts in raw
            ]
        else:
            events = raw
        print(f"Loaded {len(events)} activity events")
    else:
        print("No input file provided — generating synthetic training data...")
        events = generate_synthetic_events()
        print(f"Generated {len(events)} synthetic activity events over 90 days")

    # Save events in the new format so the companion can use them directly
    print(f"Saving activity events to {events_path}...")
    with open(events_path, "w") as f:
        json.dump(events, f)
    print(f"  Written {len(events)} events")

    print("Computing idle probabilities...")
    lookup = compute_idle_lookup(events)

    with open(lookup_path, "w") as f:
        json.dump(lookup, f, indent=2, sort_keys=True)

    print(f"Saved idle lookup table ({len(lookup)} bins) to {lookup_path}")
    print("\nBin summary (idle probability by day/hour):")

    days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    for day in range(7):
        probs = []
        for hour in range(24):
            key = f"{day}_{hour}"
            prob = lookup.get(key, 0.5)
            probs.append(f"{prob:.1f}")
        print(f"  {days[day]}: {' '.join(probs)}")

    print("\n✅ Bootstrap complete. The companion app will refine the model")
    print("   with real data once 100+ activity events are collected.")


if __name__ == "__main__":
    main()
