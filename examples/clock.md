# Time Server Specification

A minimal clock app that displays the current server time to the second via polling.

## Design
- Clock is centered on the page with a clean sans-serif font
- Display time in 24-hour format as HH:MM:SS (e.g., 14:30:45)
- The clock has a title above it that is passed into the environment as APP_TITLE; if APP_TITLE is not set, display "CLOCK"
- Each digit rotates by a random angle between -5° and 5°, regenerated every second
