# DraftKit — Setup Guide

This guide covers two deployment paths:

- **[Local / Any Host](#path-1--local--any-host)** — run DraftKit on your laptop or any machine with Node.js for a single-night draft or local network use
- **[Synology NAS](#path-2--synology-nas)** — self-hosted on a Synology NAS with HTTPS and remote access over the internet

Both paths use the same server and board files. The difference is only in how you expose the app to the network.

---

## Prerequisites

- [Node.js](https://nodejs.org) v18 or higher
- `npm` (included with Node.js)
- A clone of this repository

```bash
git clone https://github.com/rebrook/draftkit.git
cd draftkit
npm install
```

---

## Path 1 — Local / Any Host

This is the simplest path. The server runs on your machine and is accessible to anyone on the same local network.

### 1. Create a board

Each board lives in its own subdirectory under `public/`. Copy the demo board as a starting point:

```bash
mkdir -p public/my-draft
cp public/demo/index.html public/my-draft/index.html
```

Open `public/my-draft/index.html` in a text editor and update the `BOARD_ID` constant near the top of the file to match your folder name:

```js
const BOARD_ID = "my-draft";
```

### 2. Start the server

```bash
node server.js
```

The server starts on port 3000. On startup it logs its detected local IP:

```
[INFO] Local access:  http://192.168.x.x:3000/draft
[INFO] Log viewer:    http://192.168.x.x:3000/logs
```

### 3. Open the board

Navigate to `http://localhost:3000/draft/my-draft` in your browser. Anyone on the same local network can connect using the IP address shown in the startup log.

### 4. Configure the board

Click **⚙️ Commissioner** in the board header. The default password is `commissioner` — change it immediately. From Commissioner Mode you can configure teams, eval stations, players, and all board settings. No code changes are required.

### Notes

- State is saved automatically to `data/my-draft.json`. This file is excluded from the repository by `.gitignore`.
- The server must be running for the board to be accessible. To keep it running persistently, use a process manager like [PM2](https://pm2.keymetrics.io): `pm2 start server.js --name draftkit`
- To make the board accessible from outside your local network, you will need to set up port forwarding on your router and optionally a DDNS hostname. See the Synology path below for a reference on how that works.

---

## Path 2 — Synology NAS

This path runs DraftKit on a Synology NAS with HTTPS and remote internet access. It is the production configuration this project was built and tested on.

**Tested on:** Synology DS920+, DSM 7.3.2, Node.js v20

### Overview

| Component | Role |
|---|---|
| Node.js + Express | Serves the board and handles WebSocket connections on port 3000 |
| DSM Reverse Proxy | Terminates HTTPS on port 443 and forwards traffic to port 3000 |
| DSM Task Scheduler | Starts the server automatically on NAS boot |
| Router port forwarding | Exposes port 443 to the internet |
| DDNS / SSL certificate | Provides a stable hostname and HTTPS |

Port 3000 is never exposed directly. All external traffic goes through the reverse proxy on port 443.

---

### Step 1 — Place files on the NAS

DraftKit runs as a tenant under a shared host server. The folder structure on the NAS is:

```
/volume1/web/
├── server.js              # host server — serves all apps
├── package.json
├── node_modules/
├── draftkit/
│   ├── changelog.json
│   ├── data/              # per-board state files (auto-created)
│   └── public/
│       └── {boardId}/
│           └── index.html
└── simchakit/             # future apps follow the same pattern
```

> **Note:** The host `server.js` is separate from DraftKit's standalone `server.js` in this repo. The host server mounts DraftKit at `/draft/` and any additional apps at their own paths. It is not published to GitHub as it is specific to this NAS setup.

The easiest way to transfer files is via SMB from Mac Finder:
- In Finder, press `⌘K` and connect to `smb://[your-nas-ip]`
- Navigate to `/volume1/web/` and create the folder structure above
- Copy all files into place

### Step 2 — Install dependencies

Open DSM and launch a terminal session, or SSH into the NAS:

```bash
cd /volume1/web
npm install
```

This creates `node_modules/`. You only need to do this once, or again if `package.json` changes.

> **Note:** `node_modules/` and `data/` are excluded from the repository. Both are created locally on the NAS and never need to be recopied after the initial setup.

### Step 3 — Set up the reverse proxy

In DSM, go to **Control Panel → Login Portal → Advanced → Reverse Proxy** and create a new rule:

| Field | Value |
|---|---|
| Source Protocol | HTTPS |
| Source Hostname | your DDNS hostname (e.g. `yournas.familyds.net`) |
| Source Port | 443 |
| Destination Protocol | HTTP |
| Destination Hostname | localhost |
| Destination Port | 3000 |

After saving, edit the rule and open the **Custom Header** tab. Click **Create → WebSocket** to add the headers required for real-time sync. Without this step, WebSocket connections will fail.

> **Key callout:** The reverse proxy path in DSM 7 is **Control Panel → Login Portal → Advanced → Reverse Proxy** — not Web Station. Web Station's portal wizard is for containerized services and does not work for this setup.

### Step 4 — Configure auto-start

In DSM, go to **Control Panel → Task Scheduler** and create a new triggered task:

| Field | Value |
|---|---|
| Task type | Triggered task — User-defined script |
| User | root |
| Event | Boot-up |
| Script | `node /volume1/web/server.js` |

Save the task. The server will now start automatically whenever the NAS boots.

To start it immediately without rebooting, select the task and click **Run**.

### Step 5 — Set up port forwarding

For the board to be accessible from outside your local network, port 443 must be forwarded through your router(s) to the NAS.

In your router's admin panel, create a port forwarding rule:
- **External port:** 443
- **Internal IP:** your NAS's local IP address
- **Internal port:** 443

> **Double NAT callout:** If your network has two routers (e.g. an ISP-provided gateway plus a mesh router), you need to forward port 443 on **both** routers in sequence — outer router forwards to inner router's IP, inner router forwards to NAS IP. This is a common home network configuration and the most frequent source of connectivity issues.

### Step 6 — SSL certificate

For HTTPS to work, your NAS needs a valid SSL certificate for your DDNS hostname. In DSM, go to **Control Panel → Security → Certificate**.

If you are using a Synology DDNS hostname (e.g. `*.familyds.net`), you can request a free Let's Encrypt certificate directly from this panel. Synology renews it automatically.

### Step 7 — Verify

Navigate to `https://your-ddns-hostname/draft/your-board-id` in a browser. You should see the board load and the sync banner briefly show "Connected."

Open the log viewer at `https://your-ddns-hostname/logs` to confirm the host server is running and clients are connecting.

---

## Creating Additional Boards

Each board is an independent instance with its own state, commissioner config, and password. To add a board:

1. Create a new folder under `draftkit/public/`: `mkdir -p /volume1/web/draftkit/public/new-board-id`
2. Copy an existing board HTML into it from any existing board folder
3. Update the `BOARD_ID` constant at the top of the new `index.html` to match the folder name, prefixed with `draft-` (e.g. `"draft-new-board-id"`)
4. No server restart is required — the host server picks up new boards dynamically

State for the new board is saved automatically to `draftkit/data/draft-new-board-id.json` on first use.

---

## Season Management

### End-of-season: closing out a completed board

When the season is over, the recommended workflow is to archive the board rather than deleting or resetting it. Archiving locks it permanently as a read-only record that remains accessible at its original URL.

**Step 1 — Export your records (optional but recommended)**

Before archiving, use the Export button to download the final draft sheet and per-team rosters as `.xlsx` files. Use Print / Save PDF on the Draft Recap for a printable summary. These are your offline backups — once the board is archived, no data can change but having local copies is good practice.

**Step 2 — Archive the board**

In Commissioner Mode → Board Settings, click **Archive Board**. You will be prompted to:
- Enter the commissioner password
- Set an archive unlock code (at least 4 characters) — store this somewhere safe, it is the only way to unarchive later
- Type `ARCHIVE` to confirm

Once archived, the board is fully locked. All coach controls are disabled. The board remains viewable at its original URL as a permanent season record.

> **What archiving does not do:** it does not delete any files, free up the board ID, or affect any other boards. The state file (`draftkit/data/{boardId}.json`) remains on disk unchanged.

**Step 3 — Note the archived board's URL**

The archived board stays accessible indefinitely at `https://your-hostname/draft/{boardId}`. Share this URL with coaches if they want to reference last season's results.

---

### Starting a new season: creating a fresh board

Do this after archiving the old board, not instead of it. The new board is completely independent — its own folder, its own state file, its own commissioner config and password.

**Step 1 — Choose a board ID**

Pick a board ID that identifies the season clearly, for example `pgs-2027`. The ID becomes part of the URL and the state filename — keep it lowercase with no spaces.

**Step 2 — Create the folder and copy the HTML**

On the NAS, via Finder over SMB or File Station:

1. Navigate to `/volume1/web/draftkit/public/`
2. Create a new folder with your chosen board ID (e.g. `pgs-2027`)
3. Copy `index.html` from any existing board folder into the new folder

**Step 3 — Update the BOARD_ID constant**

Open the new `index.html` in a text editor and find the `BOARD_ID` constant near the top of the file. Update it to match the new folder name, prefixed with `draft-`:

```js
const BOARD_ID = "draft-pgs-2027";
```

Save the file and copy it back to the NAS. This is the only code change required.

**Step 4 — Verify the new board loads**

No server restart is needed. Navigate to `https://your-hostname/draft/pgs-2027` — the board should load fresh with no draft state and the default Springfield demo configuration.

**Step 5 — Configure the new board**

Open Commissioner Mode on the new board and configure everything from scratch:
- League name, division, year, season dates
- Teams — names, abbreviations, colors, coaches
- Eval stations — rename to match your sport and designate the priority station
- Positions — configure available position tags
- Players — add manually or import via CSV using the Download Template workflow

> **Prior season data:** player scores from the previous season can be included as prior season scores when importing players via CSV. Use the `PS1`–`PS5` columns in the import template. These populate the Scouting tab's year-over-year comparison and are used as a tiebreaker in the Next Best Available algorithm.

---

### Updating board files mid-season

The board HTML (`index.html`) can be updated at any time without restarting the server:

1. Replace the `index.html` file in the board's folder on the NAS (via Finder over SMB or File Station)
2. Reload the page in any connected browser

Live draft state is held in memory and persisted to `draftkit/data/{boardId}.json` — it is unaffected by replacing the HTML file.

The host `server.js` changes **do** require a server restart. In DSM Task Scheduler, select the Web Server task and click **Stop**, then **Run** to restart.

---

## Troubleshooting

**Board loads but picks don't sync across devices**
WebSocket headers are missing from the reverse proxy. Edit the reverse proxy rule in DSM, go to the Custom Header tab, and add the WebSocket headers via **Create → WebSocket**.

**Board is accessible on local network but not from the internet**
Port 443 is not forwarded correctly. Verify the forwarding rule on each router in your network. If you have double NAT, both routers need a forwarding rule.

**Server does not start on boot**
Confirm the Task Scheduler task is set to run as `root` and the script path is correct. Check the task's output log in Task Scheduler for error details.

**`node_modules` not found error on startup**
Run `npm install` in `/volume1/web/` on the NAS. This is required after the initial file copy and after any `package.json` changes.

---

*See [README.md](README.md) for full feature documentation.*
