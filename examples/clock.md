# Clock App Specification

A minimal clock app that displays the current server time (UTC) to the second. Poll the server every 1 second using setInterval (fixed cadence).

## Design
- Clock must be centered (horizontally and vertically) on the page with a clean sans-serif font
- Display time in 12-hour format as HH:MM:SS (e.g., 14:30:45) in Pacific Time
- The clock has a title above it that is passed into the environment as APP_TITLE; if APP_TITLE is not set, display "Time"
- Each digit rotates by a random angle between -10° and 10°, regenerated every second
- A background gradient should slowly mutate colors and angles (alwways start with a orange+peach combination)
- Add falling pizza emojis 

## Env Vars
