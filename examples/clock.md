# Clock App Specification

A minimal clock app that displays the current server time to the second. 

## Design
- Clock must be centered (horizontally and vertically) on the page with a clean sans-serif font
- The clock should update every second
- Display time in 12-hour format as HH:MM:SS without AM/PM indicator (e.g., 2:30:45) in the America/Los_Angeles timezone
- The clock has a title above it that is passed into the environment as APP_TITLE; if APP_TITLE is not set, display "AI Tinkerers"
- Each digit rotates by a random angle between -8° and 8°, regenerated every second
- A background gradient should slowly mutate colors and angles (alwways start with a orange+peach combination)
- Pizza emojis of random size and orientation should fall in the background
- Clicking anywhere on the screen should chnagethe time format to 24 hour time

## Env Vars
- `APP_TITLE` — Title displayed above the clock. Default: `"AI Tinkerers"`
