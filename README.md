# Multiplayer Tic-Tac-Toe with Nakama

This project implements the Lila backend assignment as a server-authoritative multiplayer Tic-Tac-Toe game on Nakama.

## 🌐 Live Deployment

- 🔗 Frontend (Netlify): https://lila-tictactoe-frontend.netlify.app
- ⚙️ Backend (Nakama on Render): https://lila-nakama-backend.onrender.com
- 💻 Source Code: https://github.com/faraz3336/lila-tictactoe

## What is included

- Server-authoritative Tic-Tac-Toe logic in [`data/modules/match.js`](/C:/nakama-server/data/modules/match.js)
- Public room creation through Nakama RPC
- Automatic matchmaking through `registerMatchmakerMatched`
- Match discovery and join flow through the web client
- Real-time board updates, turn validation, disconnect handling, and rematches
- Responsive web frontend in [`frontend/index.html`](/C:/nakama-server/frontend/index.html), [`frontend/app.js`](/C:/nakama-server/frontend/app.js), and [`frontend/styles.css`](/C:/nakama-server/frontend/styles.css)

## Architecture

- Nakama runs the full game state and validates every move before it is applied.
- The client only sends intents such as `move` and `rematch`.
- Match labels expose room metadata so public rooms can be listed and joined.
- Matchmaker matches create authoritative rooms on the server and return a match token to both players.
- Disconnects are reflected immediately; if a player does not return within the grace window, the opponent wins by forfeit.

## Local setup

### 1. Start Nakama and Postgres

```bash
docker compose up
```

The provided [`docker-compose.yml`](/C:/nakama-server/docker-compose.yml) starts:

- Postgres on `localhost:5432`
- Nakama HTTP/WebSocket API on `localhost:7350`
- Nakama console on `localhost:7351`

### 2. Serve the frontend

Serve the `frontend` directory with any static file server.

Examples:

```bash
npx serve frontend
```

or

```bash
cd frontend && python -m http.server 8080
```

Then open the frontend in your browser. Use:

- Host: `127.0.0.1`
- Port: `7350`
- SSL: unchecked

## How to test multiplayer

1. Open the frontend in two separate browser windows or one normal window plus one incognito window.
2. Login as two different device identities.
3. Test either flow:
   - Create a public room in one client and join it from the other.
   - Press `Auto Match` in both clients and wait for the server to pair them.
4. Confirm that:
   - only the active player can move
   - occupied cells are rejected
   - wins and draws are announced to both clients
   - rematch requires both players
   - disconnecting one player updates the room state and eventually forfeits the game if they do not return

## Deployment notes

- Deploy the frontend as a static web app on Netlify, Vercel, GitHub Pages, or any static host.
- Deploy Nakama and Postgres on a cloud VM or container platform.
- Point the frontend connection form to your deployed Nakama hostname and port.
- If you terminate TLS in front of Nakama, enable the SSL toggle in the client.

## Render backend deployment

This repo now includes:

- [`render.yaml`](/C:/nakama-server/render.yaml) for a Render Blueprint
- [`Dockerfile`](/C:/nakama-server/Dockerfile) to package Nakama with the runtime module
- [`deploy/start-nakama.sh`](/C:/nakama-server/deploy/start-nakama.sh) to run migrations and start Nakama on Render

### Important prerequisite

Render Blueprints must live in a Git repository that is pushed to GitHub, GitLab, or Bitbucket. This folder is not currently connected to a Git remote, so push it to a Git provider before creating the Render service.

### Render services

The Blueprint provisions:

- one Render web service for Nakama
- one Render Postgres database

### Required Render secrets

When you create the Blueprint in Render, set these secret environment variables:

- `NAKAMA_SERVER_KEY`
- `NAKAMA_RUNTIME_HTTP_KEY`
- `NAKAMA_SESSION_ENCRYPTION_KEY`
- `NAKAMA_REFRESH_ENCRYPTION_KEY`
- `NAKAMA_CONSOLE_PASSWORD`
- `NAKAMA_CONSOLE_SIGNING_KEY`

Recommended: use long random strings for all of them.

### Render deploy flow

1. Push this repo to GitHub, GitLab, or Bitbucket.
2. In Render, create a new Blueprint from that repository.
3. Review the generated `lila-nakama-backend` web service and `lila-nakama-db` database.
4. Fill in the required secret environment variables.
5. Apply the Blueprint.
6. After the backend is live, note the public Render hostname, such as `your-service.onrender.com`.

## Netlify frontend deployment

This repo now includes:

- [`netlify.toml`](/C:/nakama-server/netlify.toml)
- [`frontend/build.mjs`](/C:/nakama-server/frontend/build.mjs)
- [`frontend/app-config.js`](/C:/nakama-server/frontend/app-config.js)

The Netlify build produces a deploy-ready static site in `frontend/dist`.

### Required Netlify build environment variables

Set these in Netlify before the production deploy:

- `NAKAMA_HOST`: your Render backend hostname, for example `your-service.onrender.com`
- `NAKAMA_PORT`: `443`
- `NAKAMA_SSL`: `true`

### Netlify deploy flow

1. Create or link a Netlify site.
2. Set the build environment variables above.
3. Use the repo root as the project root.
4. Netlify will read `netlify.toml`, run the frontend build, and publish `frontend/dist`.
5. Open the deployed site and confirm the connection form is prefilled with the Render backend hostname.

## Post-deploy checklist

1. Open the Netlify frontend in two browser windows.
2. Confirm the connection defaults point to the Render backend with SSL enabled.
3. Login in both windows.
4. Create a room and join it from the second client.
5. Verify match start, move validation, win detection, and rematch flow.

## Design decisions

- The frontend is intentionally framework-free so it is easy to host as a static web app.
- Server-authoritative logic lives entirely inside the Nakama runtime module.
- Manual room creation and automatic matchmaking are both supported because they are separate assignment requirements.
- The room list uses server labels for discovery metadata but never trusts the client for gameplay state.
