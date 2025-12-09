# Zero Debugging Guide

## Browser Skill Commands

```bash
# Navigate
node ~/.claude/skills/playwright-skill/browser-client.js navigate "http://localhost:5173"

# Reload
node ~/.claude/skills/playwright-skill/browser-client.js reload

# Screenshot (with UI)
node ~/.claude/skills/playwright-skill/browser-client.js screenshot /tmp/shot.png

# Screenshot (canvas only, no UI) - saves context tokens
node ~/.claude/skills/playwright-skill/browser-client.js screenshot-clean /tmp/clean.png "#globe" "#ui"

# Resize viewport (smaller = fewer tokens)
node ~/.claude/skills/playwright-skill/browser-client.js resize 400 400

# Console logs
node ~/.claude/skills/playwright-skill/browser-client.js console
node ~/.claude/skills/playwright-skill/browser-client.js console-clear

# Execute JS
node ~/.claude/skills/playwright-skill/browser-client.js exec "expression"
```

## Screenshot Token Cost

```
tokens ≈ (width × height) / 750

900×880 = ~1,056 tokens
400×400 = ~213 tokens (5x savings)
300×300 = ~120 tokens
200×200 = ~53 tokens
```

## Camera Control (Console)

```javascript
// Access camera
const cam = __hypatia.app.getRenderer().camera;

// Set position (lat, lon, distance)
cam.setPosition(0, 0, 2.0);      // Equator, Africa, zoomed
cam.setPosition(0, -90, 2.0);    // Equator, Americas
cam.setPosition(45, 0, 3.0);     // Europe, zoomed out

// Direct property access
cam.lat = 30;
cam.lon = -45;
cam.distance = 2.5;

// Get state
cam.getState();                   // {lat, lon, distance}
cam.getEyePosition();            // Float32Array [x, y, z]
cam.getViewProjInverse();        // Float32Array [16]
```

## Service Access (Console)

```javascript
// All services exposed at localhost
__hypatia.app                    // Main app
__hypatia.config                 // ConfigService
__hypatia.options                // OptionsService
__hypatia.state                  // StateService
__hypatia.tracker                // TrackerService
__hypatia.dateTime               // DateTimeService

// Get renderer
__hypatia.app.getRenderer()

// Toggle layers
__hypatia.state.toggleLayer('grid')
__hypatia.state.toggleLayer('sun')
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ← / → | ±1 hour (to full hour) |
| Shift + ← / → | ±10 minutes (to 10-min mark) |
| Ctrl/Cmd + ← / → | ±24 hours |

## Common Issues

### Black screen
- Check console for WGSL errors
- Verify camera distance > 1.0 (sphere radius)
- Check viewProjInverse matrix for NaN/Infinity

### Globe off-center
- Matrix math issue in lookAt or inverse
- Check eye position matches lat/lon/distance

### Texture not showing
- Check basemap loaded (6 cube faces)
- Verify texture binding in shader
