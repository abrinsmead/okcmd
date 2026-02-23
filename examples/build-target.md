# Example Build Target

This system accepts POST requests to /build simulating a build system. 

THIS IS NOT A WEB APP. JUST BUILD IT IN EXPRESS OR HONO.

## Payload

The POSTed payload will look like this.

```json
 {
    "project": {
      "id": "uuid",
      "name": "My Project"
    },
    "files": [
      {
        "name": "readme.md",
        "content": "# Hello world\n...",
        "updatedAt": "2026-02-20T12:00:00.000Z"
      }
    ],
    "builtAt": "2026-02-20T12:34:56.000Z",
    "callback": {
      "url": "https://your-app.com/api/build/callback",
      "token": "uuid",
      "buildId": "uuid"
    }
  }
```

## Response Payload

The service will extract the callback url token and build id and use it to async send a response back to the caller when the build is finished. 

Because this is a mock build service, the service will wait 15 seconds then tell the caller that the build succeeded.

The response body should contain lorem ipsum style fake build results. 

The POST payload format for the callback is 

```json
  {
    "buildId": "uuid",
    "token": "uuid",
    "status": "success" | "failed" | "running",
    "body": "Optional log output or error message"
  }
```

## Logging

Log inbound and outbound payloads with pretty printing. 

## Special Exception

Because we run in docker use this address for the base URL for our callbacks: http://host.docker.internal
 