# Virtual Try-On

Browser app that opens the webcam and places glasses, hats, and clothing on the person in frame, one item per category worn together. A photobooth takes timed runs of shots with a swapped background and stickers, and prints them as one sheet. Everything you capture lands in an on-device gallery. Tracking runs on-device with MediaPipe Tasks Vision. No backend.

## Run

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173 and allow the camera. The `predev` step copies the MediaPipe wasm runtime into `public/wasm` so it is served from the same origin. The camera API needs `localhost` or HTTPS.

Other scripts:

| Command | Purpose |
|---|---|
| `pnpm test` | Unit tests for the anchor math |
| `pnpm build` | Typecheck and production bundle in `dist/` |
| `pnpm preview` | Serve the production bundle |
| `pnpm gen:samples` | Regenerate the sample PNGs in `public/items` |

Add `?debug=1` to the URL to draw the landmark indices the anchors use. The Size slider trims the worn item of the active category between 70% and 150%.

## Quick access and trial

The app opens on a quick access page with no email or password. **Enter the app** opens a new 14-day trial workspace at once, covering up to 3 locations and 10 points. The business name is optional; left blank, the workspace is called Store 1, Store 2 and so on. Workspaces already saved in this browser show above the form with their days left, and one tap on a tile opens that workspace again. The camera and the tracking models only start after entry. The avatar pill in the header shows the days left and opens the workspace sheet, where **Switch workspace** returns to the quick access page. Opening a workspace whose trial has ended shows a "trial has ended" card instead of the app, and the backend refuses every change while still returning the saved data.

`src/account/backend.ts` defines `AccountBackend`, the one interface the app uses for workspaces, locations and points. The trial build ships `createLocalBackend`, which keeps everything in this browser's localStorage. Anyone who uses the browser can open any workspace saved in it, and nothing syncs between devices. Workspaces created by the earlier email and password build still appear and open, since their stored entries keep the same `{ account }` shape. For production, implement the same interface against a server that owns the accounts and issues sessions, and swap it in at `createLocalBackend(browserStore())` in `src/main.ts`.

## Screens

The shell follows the house UI style: a soft grey canvas, borderless white cards, one ink surface and one coral accent. Desktop and tablet get a floating dark rail; phones get a floating dark bottom bar with Dashboard, Try on, the capture button, Photobooth and More, which opens a sheet holding Gallery and Locations. The round accent button in either one takes a snapshot on **Try on**, starts a run on **Photobooth**, and returns to the camera from **Gallery** and **Locations**.

- **Dashboard** sums up the captures saved on this device over the last 7 or 30 days (the switch is remembered). A dark hero card leads with the total, the change against the period before, and a column per day with today in the accent; hovering or focusing a column shows its date and count, and a hidden table carries the same numbers for screen readers. Beside it, a **Needs attention** card turns coral when something needs a person: the trial ends within 3 days, there are no locations or points yet, this device is not linked to a point, or an active point captured nothing in the period. Each item has a button that goes to the fix. Below sit stat cards (snapshots, photobooth sheets, active points, locations), **Top points** and **By location** ranked with bars, and the six most recent captures with the point that took them. `src/dashboard-stats.ts` does the counting (tested) and `src/dashboard-view.ts` draws it. A device with no point opens on the dashboard after sign-in; a kiosk linked to a point opens on Try on.
- **Try on** holds the camera and the Wear card: category tabs, the first six items with "Show all", the Size slider, Upload PNG and Snapshot. Hold up ✌️ for a 3 second snapshot countdown. Snapshots go to the gallery.
- **Photobooth** is one card with a four-step flow, so the panel stays short: **Layout** (strip, 2x2 grid or single, each drawn as a small diagram), **Background** (a **Scenery** tab of six landscape photos, and a **Studio** tab with blur, painted backdrops or your own photo; with a mouse, hovering a tile previews it on the camera before you click), **Stickers** (emoji and text badges you drag on the camera) and **Print** (frame colour, timer, caption, then Start). The steps are clickable at any time, Back and Continue walk them in order, and a line under the card gives the shot count and run length. A preview of the sheet as it would print sits in a corner of the camera through every step, redrawn when a setting changes and every second to follow the camera. Start runs a countdown before each shot, flashes, prints the sheet and shows it in the same card with Download, Gallery and New sheet. Hold up ✌️ to start hands-free; the run will not restart until the hand drops.
- The camera card takes the shape of the camera's own video once it reports its size, so a landscape webcam on a phone does not leave tall black bars that push the controls off screen.
- **Gallery** lists every snapshot and sheet, newest first, with download and a two-tap delete.
- **Locations** is the master data. A location is a store, mall or venue, and each one holds its points: the kiosks, mirrors and booths that run the app. Each location card lists its points with code and status, and a footer counts points, active points and captures. Adding a location goes straight on to its first point. A point's code is suggested from the location name (GRA-01, GRA-02) and must be unique across the account. Pausing a point keeps it listed but takes it out of the device picker. Deleting a location asks first and removes its points; captures already saved stay in the gallery. The Add buttons turn off at the trial limits. Search matches location names, cities, addresses, point names and codes. A **Cards | Table** switch next to search picks the layout, and the device remembers it. The table lists every point under a header row for its location, with code, status, captures and actions; clicking a row opens the point. On phones the table drops the code and captures columns, shows the code under the name, and shrinks the status to its dot, so it fits 375 px without scrolling sideways.
- **This device** (the card above the Try on and Photobooth panels) says which point the device runs as. Every snapshot and sheet saved there carries that point, the gallery shows it under the date, and the Locations page counts captures per point. The choice is stored per device and per account, since each kiosk sets its own.
- **Share** (on a finished photobooth sheet, and on every gallery card) lays the capture out for Instagram: **Post** 4:5 at 1080 x 1350, the tallest shape the feed shows uncropped; **Square** 1080 x 1080; **Story** 9:16 at 1080 x 1920; or **Original**. The picture sits whole inside the frame over a blur of itself, or over plain Paper or Ink. Stories keep the top 250 px and bottom 280 px clear, where Instagram draws the profile row and the reply field. **Share** hands the file to the phone's own share sheet through the Web Share API, which is how a web page reaches Instagram, WhatsApp and the rest; browsers without file sharing hide it and make **Save** the main action. **Copy** puts a PNG on the clipboard for pasting into web apps. Social sizes save as JPEG at 92% quality, since Instagram recompresses uploads anyway; Original stays PNG. `src/social.ts` holds the sizes and the layout math (tested); `src/share-dialog.ts` is the sheet, a centred dialog on desktop and a bottom sheet with pinned actions on phones.
- **Hand control** (the hand button in the header) lets you work the app from a step back. The point between your thumb tip and index tip moves a cursor over the whole screen, a pinch clicks, and a pinch held while moving drags, which is how stickers move. ✌️ still captures: a snapshot countdown on Try on, a photobooth run on Photobooth. The same gesture recognizer supplies both the gesture and the 21 hand landmarks, so the cursor costs no extra model. A comfortable arm movement covers the screen because only the middle of the camera frame maps onto it (`REACH` in `src/hand-cursor.ts`). Browsers only open a file picker for a real click, so Upload still needs the mouse.

The scenery photos come from Wikimedia Commons and are each released as CC0 or public domain, so they need no permission or credit: Serene Tropical Beach with Lush Greenery, Nagari tuo Pariangan (West Sumatra), Forest Away Path, Lake Mountain Landscape, Mirror Lake and the Beartooth Mountains, and Absaroka Range with alpenglow. The app loads the 1280 px renditions on first use, so none of them live in the repository; Commons serves them with open CORS headers, which keeps captured frames exportable.

`src/photobooth.ts` holds the sheet geometry (tested), the compositing and the timed run. `src/render/background-layer.ts` draws the backdrop over the video with a hole where the segmenter found the person, so the live camera shows through; the mask is feathered at mask resolution, where a 1 px blur is cheap. `src/stickers.ts` keeps the stickers in a layer outside the mirrored stage, maps their positions through the `object-fit: contain` letterboxing, and stamps them onto each captured frame. `src/gallery.ts` stores captures in IndexedDB and falls back to memory when the browser refuses storage.

## Two modes

**On device** is the default and everything below describes it. It runs entirely in the browser, costs nothing and sends no video anywhere.

**Decart AI** streams the camera to Decart's hosted try-on model and plays the generated video that comes back. The model repaints every frame with the garment worn, so it renders folds, shadows and body rotation, and it covers the clothes you already have on. A geometric overlay cannot do any of that. It needs your own API key, it bills per second of streaming, and your camera leaves the machine while it runs. `src/decart.ts` holds the session: `client.realtime.connect(stream, ...)` with the `lucy-vton-latest` model, then `setImage(url, { prompt })` per garment, which switches clothes without reconnecting.

The key is read from a field and kept in `sessionStorage`, so it never reaches disk and disappears when the tab closes. Decart's own guidance for a public deployment is different: keep the permanent key on a server and hand the browser short-lived client tokens from `client.tokens.create()`, which expire after ten minutes. This app has no server, so it takes the key directly.

Decart AI mode changes clothing only. Glasses and hats stay in on-device mode.

## How it works

- `src/tracking/face.ts` runs the Face Landmarker for glasses and hats. `src/tracking/pose.ts` runs the Pose Landmarker for clothing. A detector runs only while an item that needs it is worn, and each is created on first use and kept alive.
- `src/tracking/gesture.ts` runs the Gesture Recognizer every frame. `src/capture-trigger.ts` turns a peace sign held for 8 frames into a 3 second countdown, fires one capture, then ignores gestures for 3 seconds. The trigger gesture and timings are set where `CaptureTrigger` is constructed in `src/main.ts`.
- `src/anchors.ts` turns face landmarks into an anchor (center, angle, width) for glasses and hats, smoothed with an exponential moving average. Glasses use outer eye corners 33 and 263. Hats center on forehead point 10 with width from head sides 234 and 454. `src/render/overlay.ts` draws those two rotated around their anchor.
- Clothing follows the body instead of sitting rigid. `src/garment.ts` reads the garment's own outline to find its shoulder seam, hip line and cuffs, then pairs those with the pose skeleton. `src/mls.ts` builds a Moving Least Squares deformation from those pairs, and `src/render/warp.ts` redraws the photo as a triangle mesh through it. The garment then leans, turns and stretches with the torso, and its sleeves travel down the arms toward the elbows and wrists.
- Three rules keep the size honest. The shoulder seam alone sets the scale, so the garment is exactly `scale` times the pose shoulder span. The torso mapping stays a rotation plus uniform scale, so the body supplies only the lean and a short torso wears the same garment lower rather than squashing it. The collar top is pinned just above the shoulder line, because a photo lays the collar and shoulder slope out flat and that band would otherwise ride up over the chin.
- Pose shoulder landmarks mark the joint centers, which sit well inside the shoulder outline, so the clothing default reaches about half again as wide (`scale` 1.45). The Size slider trims that live per category and covers the rest of the variation between builds and camera distances.
- Both axes of the deformation work in texture pixels rather than 0 to 1 coordinates. A similarity in a squashed coordinate space is not a similarity on screen, and that mismatch showed up as garments that were too wide for their height.
- A cuff only follows an arm when the photo shows the sleeve spread out, which `measureGarment` decides by comparing the widest point above mid height against the body below it. A shirt photographed with its sleeves hanging down the sides keeps to the torso, which avoids smearing it sideways.
- The garment is trimmed to the wearer's outline, which is what stops it reading as a sticker. `src/tracking/segmenter.ts` runs the selfie multiclass segmenter, and `src/render/occlusion.ts` turns its per-pixel classes into the silhouette the garment may occupy: the person, minus hair, face and accessories, minus bare skin that falls inside the torso. Nothing spills onto the room behind, and a hand raised to the chest passes in front of the shirt. Skin outside the torso stays available so the sleeves keep wrapping the arms they are drawn on.
- Because the outline does the trimming, `scale` only has to be generous enough to cover the body. Excess width is clipped away rather than hanging off the shoulders, so the setting is forgiving in one direction and not the other.
- `src/render/garment-layer.ts` composites the result. It warps the photo, blends a blurred grayscale copy of the frame over it with `soft-light` so the garment picks up the room's light and the body's shading, then punches out the cutout.
- The video and canvas sit in one container flipped with CSS, so landmark math stays in raw camera coordinates.
- `src/catalog.ts` holds the items. For glasses and hats, `scale` multiplies the anchor width, `offsetX` and `offsetY` are in anchor-width units, and `pivotY` picks which fraction of the image height rests on the anchor point. Clothing ignores those and uses `scale` alone, as how far the garment sits past the shoulder joints.

Segmentation is fed a frame shrunk to 256 px wide. The mask returns at the size it went in, and pulling it off the GPU costs time in proportion to its area: a full camera frame took 47 ms per call against 1.4 ms of inference. At 256 px the whole call costs about 16 ms, and it runs every other frame.

Rough cost per camera frame on an Apple Silicon laptop, with a garment worn:

| Stage | Time |
|---|---|
| Pose landmarks | 6.5 ms |
| Gesture recognition | 11.9 ms |
| Segmentation, halved by running every other frame | 8.1 ms |
| Warp, shading and cutout | 1 ms |

Models load from Google's storage bucket:

- `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
- `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`
- `https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`
- `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite` (16 MB, downloaded once and cached)

## Real products

On load the app pulls real product photos from the DummyJSON sample store (`https://dummyjson.com/products/category/...`): men's shirts and tops appear under Clothing, sunglasses under Glasses. These are transparent 1000x1000 cutouts served with open CORS headers, so captured frames stay exportable. `src/store-catalog.ts` maps each product to a catalog item. To point the app at your own store, return the same `{ products: [{ id, title, images }] }` shape from your API and change the `SOURCES` list there.

Product photos come with transparent padding, so `loadImage` in `src/catalog.ts` crops every image to its opaque bounds and measures its outline before drawing. Sizing then follows the garment's own shoulder seam rather than the photo frame, which is why no per-product tuning is needed. A cross-origin image without CORS headers cannot be read pixel by pixel, so it falls back to a nominal outline.

Hats have no store source yet. PurePNG (CC0) has cap cutouts if you want to add real ones by hand.

## Adding items

Drop a transparent PNG into `public/items` and add an entry to `DEFAULT_ITEMS` in `src/catalog.ts`. For glasses and hats, tune `scale` first, then `offsetY`. Clothing needs no tuning: photograph the garment flat and facing the camera, and the warp sizes it from its own shoulder line. Users can also press Upload PNG to try any transparent PNG in the current category without a code change. Tapping a worn item in the strip takes it off.
