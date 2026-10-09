# EarthCraft: Minecraft inside the real world

![Minecraft Java 1.21.1](https://img.shields.io/badge/Minecraft-Java%201.21.1-62b47a) ![Fabric](https://img.shields.io/badge/Fabric-mod-dbd0b4) ![Windows](https://img.shields.io/badge/Windows-11-0078d4) ![License MIT](https://img.shields.io/badge/license-MIT-green)

Google's photorealistic 3D map becomes your Minecraft world. Fly over Manhattan, summon an Ender Dragon at Big Ben, dig a hole in Times Square, build a dirt house on the Brandenburg Gate.

- The city you see is the real Google 3D map, not blocks.
- Invisible blocks sit underneath, so you can **walk, mine, build, fly with elytra, use TNT and summon mobs**. Mined spots cut through the real map.
- Rivers and lakes (from OpenStreetMap) turn into real Minecraft water.
- Travel anywhere with one command: `/earth goto <place>`.

> Not affiliated with Mojang, Microsoft or Google. Minecraft is **not** included, you need your own copy of Minecraft: Java Edition.

---

## Quick start (about 10 minutes)

### What you need
| | |
|---|---|
| Windows 10/11 | tested on Windows 11 only |
| [Minecraft Java Edition](https://www.minecraft.net) with the official Launcher | |
| [Node.js 20+](https://nodejs.org) | runs the small local map service |
| [Java 21+](https://adoptium.net) | for the Fabric installer |
| A Google account | for your own API key (step 1) |
| A decent PC | 16 GB RAM and a dedicated GPU recommended |

### Step 1: Get your own free Google API key
This project does **not** include a key and never will. Everybody uses their own, and Google bills you directly (the free monthly credit is normally enough for personal play).

1. Open <https://console.cloud.google.com>, create a project and link a billing account (Google requires it).
2. Go to **APIs & Services > Library** and enable **Map Tiles API**. Also enable **Geocoding API** if you want to type addresses (`/earth goto Times Square, New York`). Coordinates work without it.
3. Go to **APIs & Services > Credentials > Create credentials > API key**. Click the key and under *API restrictions* allow only **Map Tiles API** and **Geocoding API**.
4. **Keep the key secret.** Never post it, never commit it, never share screenshots of it.

### Step 2: Install
1. Download the zip from [Releases](../../releases), unzip it anywhere (a short path like `C:\EarthCraft` is best).
2. Copy `service\config.example.json` to `service\config.json` and paste your key:
   ```json
   { "apiKey": "YOUR_KEY_HERE" }
   ```
3. Right-click **`install.ps1`** > *Run with PowerShell* (or run `powershell -ExecutionPolicy Bypass -File install.ps1`).
   It installs Fabric for Minecraft 1.21.1, Fabric API and the mod, and gives that profile 6 GB of RAM.

### Step 3: Play
1. Open the Minecraft Launcher, choose the profile **fabric-loader-1.21.1**, press *Play*.
2. **Singleplayer > Create New World > More World Options > World Type: `EarthCraft (Google 3D)`**.
3. Optional but handy: set *Game Mode* to **Creative** and *Allow Cheats* **On**.
4. You start at the Brandenburg Gate in Berlin. The first load takes about a minute while the city streams in.

---

## How to travel

Open the chat (**T**) and type:

```
/earth goto <place or coordinates>
```

### Example destinations (copy and paste)

| Place | Command |
|---|---|
| Brandenburg Gate, Berlin | `/earth goto 52.5163, 13.3777` |
| TV Tower, Berlin | `/earth goto 52.5208, 13.4094` |
| Times Square, New York | `/earth goto 40.7580, -73.9855` |
| Empire State Building, New York | `/earth goto 40.7484, -73.9857` |
| Statue of Liberty | `/earth goto 40.6892, -74.0445` |
| Big Ben, London | `/earth goto 51.5007, -0.1246` |
| Tower Bridge, London | `/earth goto 51.5055, -0.0754` |
| Sagrada Familia, Barcelona | `/earth goto 41.4036, 2.1744` |
| Eiffel Tower, Paris | `/earth goto 48.8584, 2.2945` |
| Shibuya Crossing, Tokyo | `/earth goto 35.6595, 139.7005` |
| Tokyo Tower | `/earth goto 35.6586, 139.7454` |
| Sydney Opera House | `/earth goto -33.8568, 151.2153` |
| Chicago, "The Bean" | `/earth goto 41.8827, -87.6233` |
| Cologne Cathedral | `/earth goto 50.9413, 6.9583` |

With the Geocoding API enabled you can also use addresses: `/earth goto Marienplatz 1, Munich`.

**Find your own spot:** right-click any place in Google Maps and click the first line (the numbers) to copy the coordinates, then `/earth goto <paste>`.

### Other commands
| Command | What it does |
|---|---|
| `/earth where` | shows where you are in the real world, with a Google Maps link |
| `/earth setlocation <lat> <lon>` | start location for *new* worlds |

Every place you visit gets its own area inside the same world, so your builds in one city stay when you travel to another.

### Fun things to try
```
/gamemode creative
/give @s elytra
/give @s firework_rocket 64
/time set 6000
/summon minecraft:ender_dragon ~ ~50 ~
/data modify entity @e[type=minecraft:ender_dragon,limit=1] DragonPhase set value 0
```
(The dragon only flies around the world's start location. For a dragon in Manhattan, create your world with start `40.7484, -73.9857`: edit `latitude` and `longitude` in `%APPDATA%\.minecraft\config\earthcraft.json` before creating the world.)

---

## Good to know
- **Quality depends on Google's coverage.** Big cities look great, villages are rough or empty. If a place looks blurry, try another.
- **Height limit:** about 575 m above the ground. Skyscrapers up to about 450 m fit, the Burj Khalifa does not.
- **Mountains:** places on tall hills may not line up with the valley below.
- **Cost:** every user pays for their own Google usage. Check your budget alerts in the Google Cloud Console.
- **Shaders** (Iris/Optifine) are untested and probably not compatible.

## Troubleshooting
| Problem | Fix |
|---|---|
| Red text "service not reachable" | Run `start-service.bat`, or check that Node.js is installed (`node -v`) |
| World stays flat/empty | Your key is missing or has no Map Tiles API. Look into `service\service.log` |
| `/earth goto <address>` says "not found" | Enable the Geocoding API for your key, or use coordinates |
| Stutters | Lower the render distance, close other programs, give the profile more RAM |

## Legal
- Google's **Map Tiles API terms** apply to you as the API user: keep the on-screen attribution, do not export, redistribute or permanently store tiles. The disk cache is **off** by default (`diskCache` in `service/config.json`), enabling it is your responsibility.
- Water data: (c) OpenStreetMap contributors, ODbL.
- Code: MIT License (see `LICENSE`).

## For developers
```bash
cd service && npm install && npm test        # tests against a fake Google tile server
cd mod && ./gradlew build                     # builds build/libs/earthcraft-*.jar
```
The Node service streams and voxelizes Google's 3D Tiles. The Fabric mod generates chunks from it and draws the original meshes.
