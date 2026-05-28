"""
events.py - registry of curated historical precipitation events for hindcast.

To add a new event:
  1. Add a new dict to HISTORICAL_EVENTS below
  2. Run: python scripts/refresh.py --hindcast
  3. Commit the new files in alerts/data/historical/
  4. Push - the frontend picks up the event from events.json automatically

Each entry is what the refresh script needs to fetch the right NWPS Stage IV
file AND what the frontend needs to display the event in the dropdown.

Fields:
  id              short stable identifier, used in file names.  snake_case,
                  no spaces. NEVER change once an event is committed - the
                  generated files reference this id.
  name            display label shown in the dropdown
  date_label      human-readable date range for the event (shown in UI)
  end_date        last day of the accumulation period, YYYY-MM-DD format.
                  Stage IV daily accumulations are stamped with the END
                  date of their window (12Z previous day -> 12Z this day).
  accumulation_days  how many days of accumulation to fetch (Stage IV
                     supports 1, 2, 3, 4, 5, 6, 7, 10, 14, 30, 60, 90,
                     120, 180, 365). Pick the value that best characterizes
                     the event - usually 3 days for a single-storm event,
                     7 days for a multi-day stalled system.
  description     1-2 sentence summary shown in the UI's source-meta block
"""

HISTORICAL_EVENTS = [
    # Hurricane Helene (Sept 2024) is COMMENTED OUT pending data source.
    # NWPS Stage IV files for Sept 27-29, 2024 (the storm's peak in WNC)
    # return 404 in both .tif and .nc formats. This appears to be a
    # permanent gap caused by Hurricane Helene itself: NOAA's NCEI archive
    # ingest is based in Asheville, NC and was offline during the storm.
    # From NOAA's official statement (Oct 29, 2024):
    #   "20% of the data yet to be ingested into the archive...
    #    NCEI will be working over the next several months to recover..."
    # The recovery work is ongoing. Alternative data sources to explore
    # with the NCGS team:
    #   - NASA IMERG (satellite-based, captured Helene fully)
    #   - NCSU THREDDS catalog (mirrors NWPS but may have these dates)
    #   - Re-check NWPS periodically as recovery progresses
    # {
    #     "id":                "helene_2024",
    #     "name":              "Hurricane Helene",
    #     "date_label":        "Sept 26-29, 2024",
    #     "end_date":          "2024-09-29",
    #     "accumulation_days": 3,
    #     "description":       (
    #         "Major hurricane that produced widespread debris flows across "
    #         "Western NC. Some areas received 20+ inches of rain in 72 hours."
    #     ),
    # },
    {
        "id":                "may_2026_storm",
        "name":              "May 2026 WNC Storms",
        "date_label":        "May 21-26, 2026",
        "end_date":          "2026-05-27",
        "accumulation_days": 7,
        "description":       (
            "Multi-day rainfall event that triggered flooding and "
            "landslides across Western NC."
        ),
    },
]


def get_event(event_id: str) -> dict:
    """Lookup a single event by id, or raise KeyError with the list of
    valid ids in the message for easier debugging."""
    for event in HISTORICAL_EVENTS:
        if event["id"] == event_id:
            return event
    valid = ", ".join(e["id"] for e in HISTORICAL_EVENTS)
    raise KeyError(f"No event with id {event_id!r}. Valid: {valid}")
