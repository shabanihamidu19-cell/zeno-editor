# Zeno Editor - AI-Powered Code Editor APK

Spck Code Editor clone with full-screen AI Vision Extension.
Built with **Ionic Angular + Capacitor 6 + Monaco Editor**.

## Features

- Monaco Editor (same as VS Code) with syntax highlighting for HTML, CSS, JS, TS, Python, JSON
- File Explorer with create / delete / rename, persistent storage in `Documents/ZenoProjects/`
- Multi-tab editing
- Live HTML/CSS/JS Preview (iframe split view)
- Bottom Terminal with JS eval + Python via Pyodide
- Auto-save + Ctrl+S
- **Zeno AI Vision Extension**
  - Offline Layer 1: bracket/colon auto-fix, Monaco markers
  - Online Layer 2: OpenAI-compatible API (key in Settings)
  - Sees entire project, open tabs, errors, terminal
  - Auto Debug Mode with 1.5s debounce
  - Diff + Apply Fix

## Requirements

- Node.js 18+
- Android Studio (for APK build)
- JDK 17+

## Quick Start

```bash
cd zeno-editor

# Install dependencies
npm install

# Add Capacitor Android platform (first time)
npx cap add android

# Build web assets
npm run build

# Sync to native
npx cap sync android

# Open in Android Studio
npx cap open android
```

Then in Android Studio: **Build > Build Bundle(s) / APK(s) > Build APK(s)**

## Development (Browser)

```bash
npm start
# open http://localhost:4200
```

Web mode uses localStorage as filesystem fallback. Native APK uses real Documents folder.

## AI Setup

1. Tap the gear icon
2. Paste an OpenAI-compatible API key (OpenAI, Groq, Together, DeepSeek, etc.)
3. Optionally change endpoint
4. Enable Auto Debug with the bug icon in AI panel

## Project Structure

```
src/app/
  pages/editor/          # Main editor page (Monaco + UI)
  services/
    filesystem.service.ts  # Capacitor Filesystem CRUD
    ai-vision.service.ts   # Offline linter + Online AI
capacitor.config.ts
android/app/src/main/AndroidManifest.xml  # Storage + Internet permissions
```

## Logo

Use the provided green neon `{Z}` logo for app icon (replace `android/app/src/main/res/mipmap-*`).

## License

MIT - Built for the community.
