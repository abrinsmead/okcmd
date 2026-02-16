# Todo App

A simple web-based todo list application.

## Features

- Add a todo with a text description
- Edit a todo inline
  - Edit title
  - Edit date
- Mark a todo as complete (toggle between completed and incomplete)
- Delete a todo
- List all todos, showing completed ones with a strikethrough style
- Set an optional due date on a todo
- Overdue todos (past due, incomplete) are visually highlighted
- Sort toggle: switch between newest-first and due-date-first ordering

### Tagging System
- Filter todos by tag — click a tag to show only todos with that tag, click again to clear filter
- Dropdown on task that allows multiple tag selections/unselections
- When creating or editing a todo select tags to select/unselct from multiselect control
- New tags can be added from the dropdown

### 
- Dark mode toggle (persisted to localStorage)

## Data Model

### Todo
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT
- `text`: TEXT NOT NULL (max length 500 characters, min length 1 character after trimming)
- `completed`: INTEGER NOT NULL DEFAULT 0 (0 = incomplete, 1 = complete)
- `created_at`: TEXT NOT NULL (ISO 8601 timestamp, e.g., "2024-01-15T10:30:00.000Z")
- `due_date`: TEXT DEFAULT NULL (ISO 8601 date, e.g., "2024-03-15", date-only — no time component)

### Tag
- `id`: INTEGER PRIMARY KEY AUTOINCREMENT
- `name`: TEXT NOT NULL UNIQUE (max length 50 characters, min length 1 character after trimming, stored lowercase)
- `color`: TEXT NOT NULL (hex color string, e.g. "#e74c3c", validated as `#` followed by exactly 6 hex digits)

### Todo_Tags (junction table)
- `todo_id`: INTEGER NOT NULL, FOREIGN KEY → Todo(id) ON DELETE CASCADE
- `tag_id`: INTEGER NOT NULL, FOREIGN KEY → Tag(id) ON DELETE CASCADE
- PRIMARY KEY (todo_id, tag_id)

### Validation Rules
- Todo text must not be empty after trimming whitespace
- Todo text must not exceed 500 characters
- `completed` field accepts only 0 or 1
- `due_date`, if provided, must be a valid ISO 8601 date string (YYYY-MM-DD format)
- Tag `name` must not be empty after trimming, must not exceed 50 characters, and is case-insensitive (stored lowercase)
- Tag `color` must match the pattern `#[0-9a-fA-F]{6}`
- A todo may have 0 or more tags; a tag may belong to 0 or more todos

### Ordering
- Default: `created_at` DESC (newest first)
- Due date mode: todos with due dates sorted by `due_date` ASC (soonest first), then todos without due dates

## Technical Details

### Backend
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: SQLite (file: `todos.db` in project root)
- **Port**: 3000
- **Database schema**: Create table on server startup if it doesn't exist

### Frontend
- **Framework**: React (served as static files from the Express server)
- **Styling**: CSS (no framework required)
- **Dark mode implementation**:
  - Toggle button in UI
  - Preference saved to `localStorage` key: `darkMode` (value: "true" or "false")
  - Applied via CSS class on root element
- **Due date**:
  - Date picker input on todo creation and inline editing
  - Overdue styling: incomplete todos past their due date shown with a visual indicator (e.g. red text/border)
- **Sort toggle**:
  - Button in UI to switch between newest-first and due-date-first ordering
  - Preference saved to `localStorage` key: `sortByDueDate` (value: "true" or "false")
- **Tags**:
  - Each todo displays its tags as small colored pills/badges next to the todo text
  - Tag pill shows the tag name with the tag's color as background
  - When creating a todo, a text input allows entering comma-separated tag names
  - A tag bar above the todo list shows all existing tags as clickable pills
  - Clicking a tag in the tag bar filters the list to only show todos with that tag
  - Clicking the active filter tag again clears the filter (shows all todos)
  - Active filter tag is visually distinguished (e.g. outlined or enlarged)

### API Endpoints

#### `GET /api/todos`
**Query parameters**:
- `sort` (optional): `"due_date"` to sort by due date ascending (todos without due dates last). Default sort is `created_at` DESC.
- `tag` (optional): filter by tag name (case-insensitive). Only return todos that have this tag.

**Response** (200 OK):
```json
[
  {
    "id": 1,
    "text": "Buy groceries",
    "completed": 0,
    "created_at": "2024-01-15T10:30:00.000Z",
    "due_date": "2024-03-15",
    "tags": [{ "id": 1, "name": "personal", "color": "#3498db" }]
  }
]
```
- Each todo includes a `tags` array (empty array if no tags)
- Returns empty array `[]` if no todos exist
- Default order: `created_at` DESC
- With `?sort=due_date`: `due_date` ASC (nulls last)

#### `POST /api/todos`
**Request body**:
```json
{
  "text": "string",
  "due_date": "2024-03-15",
  "tags": ["work", "urgent"]
}
```
- `due_date` is optional; omit or set to `null` for no due date
- `tags` is optional; array of tag name strings. Tags that don't exist yet are created with a random default color.

**Response** (201 Created):
```json
{
  "id": 1,
  "text": "Buy groceries",
  "completed": 0,
  "created_at": "2024-01-15T10:30:00.000Z",
  "due_date": "2024-03-15",
  "tags": [{ "id": 1, "name": "work", "color": "#3498db" }]
}
```
**Error responses**:
- 400 Bad Request if `text` is missing, empty after trimming, or exceeds 500 characters
  ```json
  { "error": "Todo text is required and must be 1-500 characters" }
  ```
- 400 Bad Request if `due_date` is provided but not a valid YYYY-MM-DD string
  ```json
  { "error": "due_date must be a valid date in YYYY-MM-DD format" }
  ```

#### `PATCH /api/todos/:id`
**Request body**:
```json
{
  "completed": true,
  "due_date": "2024-03-15",
  "tags": ["work", "personal"]
}
```
- Accepts `text` as a string (same validation as POST: 1-500 chars after trimming)
- Accepts `completed` as boolean (true/false) in request; stores as integer (1/0) in database
- Accepts `due_date` as a YYYY-MM-DD string or `null` to clear; both fields are optional
- Accepts `tags` as an array of tag name strings; replaces all existing tags on the todo. Tags that don't exist yet are created with a random default color.
- At least one field (`text`, `completed`, `due_date`, or `tags`) must be provided

**Response** (200 OK):
```json
{
  "id": 1,
  "text": "Buy groceries",
  "completed": 1,
  "created_at": "2024-01-15T10:30:00.000Z",
  "due_date": "2024-03-15",
  "tags": [{ "id": 1, "name": "work", "color": "#3498db" }]
}
```
**Error responses**:
- 400 Bad Request if `text` is provided but empty after trimming or exceeds 500 characters
  ```json
  { "error": "Todo text is required and must be 1-500 characters" }
  ```
- 400 Bad Request if `completed` is provided but not a boolean
  ```json
  { "error": "completed field must be a boolean" }
  ```
- 400 Bad Request if `due_date` is provided but not a valid YYYY-MM-DD string (and not null)
  ```json
  { "error": "due_date must be a valid date in YYYY-MM-DD format" }
  ```
- 404 Not Found if todo with given id doesn't exist
  ```json
  { "error": "Todo not found" }
  ```

#### `DELETE /api/todos/:id`
**Response** (204 No Content):
- Empty response body
**Error responses**:
- 404 Not Found if todo with given id doesn't exist
  ```json
  { "error": "Todo not found" }
  ```

#### `GET /api/tags`
**Response** (200 OK):
```json
[
  { "id": 1, "name": "work", "color": "#3498db" },
  { "id": 2, "name": "personal", "color": "#2ecc71" }
]
```
- Returns all tags ordered by `name` ASC
- Returns empty array `[]` if no tags exist

#### `POST /api/tags`
**Request body**:
```json
{ "name": "work", "color": "#3498db" }
```
**Response** (201 Created):
```json
{ "id": 1, "name": "work", "color": "#3498db" }
```
**Error responses**:
- 400 Bad Request if `name` is missing, empty after trimming, or exceeds 50 characters
  ```json
  { "error": "Tag name is required and must be 1-50 characters" }
  ```
- 400 Bad Request if `color` is missing or not a valid hex color
  ```json
  { "error": "color must be a valid hex color (e.g. #ff0000)" }
  ```
- 409 Conflict if a tag with the same name already exists
  ```json
  { "error": "Tag already exists" }
  ```

#### `DELETE /api/tags/:id`
**Response** (204 No Content):
- Empty response body
- Also removes all associations in Todo_Tags
**Error responses**:
- 404 Not Found if tag with given id doesn't exist
  ```json
  { "error": "Tag not found" }
  ```

### Error Handling
- All error responses use appropriate HTTP status codes (400, 404, 500)
- All error responses include JSON body with `error` key containing a descriptive message
- Server errors (500) return: `{ "error": "Internal server error" }`

### Project Structure
```
/
├── server.js          (Express server)
├── todos.db           (SQLite database, auto-created)
├── package.json
└── public/
    ├── index.html     (Single-page React app entry point)
    ├── bundle.js      (Bundled React code)
    └── styles.css     (Application styles including dark mode)
```

### Build & Run
- Frontend must be built/bundled before running server
- Server serves static files from `public/` directory
- Access application at `http://localhost:3000`
