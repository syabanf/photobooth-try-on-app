# Virtual Try-On

Browser app that opens the webcam and places glasses, hats, and clothing on the person in frame, one item per category worn together. A photobooth takes timed runs of shots with a swapped background and stickers, and prints them as one sheet. Everything you capture lands in an on-device gallery. Tracking runs on-device with MediaPipe Tasks Vision. The optional local photo server lets customers open booth-session files from a phone on the same network.

## Run

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173 and allow the camera. The `predev` step copies the MediaPipe wasm runtime into `public/wasm` so it is served from the same origin. The camera API needs `localhost` or HTTPS.

### Customer photo QR on a booth network

The Vite development server keeps photos in its browser only. To let a customer's phone open the QR, build and run the bundled local photo server on the booth computer:

```bash
pnpm build
pnpm serve
```

Open `http://127.0.0.1:4173` on the booth computer. The server prints its customer photo URL, normally `http://<booth-LAN-IP>:4173`. Connect the customer's phone to the same network and make sure the booth computer's firewall allows inbound TCP 4173. If the automatic IP is wrong, set `PHOTO_PUBLIC_ORIGIN=http://<reachable-IP>:4173` before `pnpm serve`. Set `PORT` if 4173 is already in use. Keep the booth browser on `127.0.0.1`; camera access needs a secure context, while the phone's photo page does not use the camera. Staff can sign in from a tablet at the LAN address: password checks and ids fall back to plain JavaScript where the browser hides WebCrypto on plain HTTP. Accounts in this build stay with the browser address they were made at, so `localhost:5173`, `127.0.0.1:4173` and `192.168.x.x:4173` each need their own account until the production account server replaces the local one.

The booth uploads each finished customer file to `.photo-delivery/` on that computer. The QR appears only after the upload succeeds. If the server is unavailable, the finish screen offers local Save buttons instead. The server accepts uploads only from the booth computer; phone links contain a random token and allow downloads. Published files use the workspace's photo retention setting at capture time. Back up `.photo-delivery/` if these files must survive a booth computer replacement. A public domain and remote access require hosting this photo service behind HTTPS.

Before opening the booth to customers, use **Staff: phone download check** on the Booth start screen. Scan its test QR with a phone on the venue Wi-Fi; the phone should say **Phone connected**. The check is hidden in customer mode. If publishing fails after a session, staff can open **Transactions → Sessions**, select the session, and choose **Restore phone link**. This re-uploads the customer files saved on that booth and shows a new QR. It requires those files to remain on the same device and within the retention period.

Other scripts:

| Command | Purpose |
|---|---|
| `pnpm test` | Unit tests |
| `pnpm build` | Typecheck and production bundle in `dist/` |
| `pnpm preview` | Serve the production bundle |
| `pnpm serve` | Serve the production bundle with compression, caching and the photo service |
| `pnpm models` | Copy the MediaPipe models into `public/models` so the booth runs without internet |
| `pnpm gen:samples` | Regenerate the sample PNGs in `public/items` |

Add `?debug=1` to the URL to draw the landmark indices the anchors use. The Size slider trims the worn item of the active category between 70% and 150%.

## Sign-in and team access (IAM)

The app opens on the Dusun Bambu sign-in screen. Nothing starts, camera and models included, until someone signs in.

- **Create an account** opens a 14-day workspace (up to 3 locations and 10 booths) and makes you its owner. It asks for the business name, your name, a work email and a password of at least 8 characters with a letter and a number. A checklist under the password ticks each rule as you type.
- **Sign in** takes email and password. Five wrong passwords lock that email for 15 minutes, and each wrong try says how many are left. A disabled person, or one whose invite is still waiting, gets a message that says so.
- **Forgot password?** explains the reset: an owner, admin or supervisor taps Reset password on the Team page and hands over a new code.
- **Set your password** takes a one-time 8-character code, such as `K7QM-2XPA`, from the owner. It also opens from the code's link or QR (`#invite=…`). Codes last 7 days and work once.
- **Needs an owner** lists workspaces made by the old quick access build. Securing one with an owner's email keeps its locations, booths and sales.
- **Access (IAM)** is its own group in More, with three pages.
  - **Users** adds a person with name, email, role, branches and PIN, and sends a sign-in code right away. The Access button per person sends or shows the code, resets the password, unlocks a locked sign-in, or turns sign-in off or on. Marking someone as left turns off their sign-in and keeps their history. Only an owner changes another owner's access, and nobody turns off their own sign-in.
  - **Roles and permissions** picks a role, lists who holds it, and switches each of its 15 permissions on or off, grouped as Selling, On the floor, Content and Running the business. A changed role carries a Changed badge and a Back to standard button. A Compare roles table shows every role side by side. The owner role keeps every permission and cannot be edited, so someone can always fix the team. Changes apply at once to every device and to the menus.
  - **Sign-in log** lists sign-ins and sign-outs, wrong passwords, locks, codes sent and accepted, resets, password changes and access turned off or on. Each line shows the device ("Chrome on macOS") and, when someone acted on another person's sign-in, who did it. Pills filter sign-ins, wrong passwords and access changes, a picker narrows it to one person, and CSV exports it. Stat cards count the last 7 days. The backend records these events itself, so a wrong password counts even though nobody is signed in. The log keeps the last 1,000 events on this device.
- **Activity history** (More → Operations) holds the workspace's history data: every change logged by sales, refunds, payments, shifts, the queue and gate, booth sessions, faces, sign-in, roles, prices, devices and alerts. Entries are grouped by day with time, person, branch, area and amount. Filters cover dates (the last 7 days by default), a person or "System and alerts", an area (with counts), a branch and words, and CSV exports the result. Branch-bound staff see their branches only. A reload of the app on the same session does not log a new sign-in. This device keeps the newest 2,000 entries; the cloud keeps the rest once synced. `src/ops/history.ts` sorts entries into areas and filters them (tested).
- **Menus follow the role.** The rail, the phone bar and More hide every page the person on the device may not open, and they update after a PIN switch. The router still refuses those pages if someone reaches them another way.
- **Your account** (the avatar pill) shows who is signed in with their role. Owners and admins also see the trial. It also holds Change password and Sign out.

**Idempotency.** Every create carries an idempotency key: register, securing a workspace, invites and setting a password from a code. The key lasts as long as the form is open. A double tap, or a retry after a dropped connection, with the same key returns the first result, so a second account, owner or code never appears. Pressing Invite again for someone whose code is still valid shows the same code. Refunds and manual QRIS confirmations check the line or payment again after the supervisor PIN check, so two taps refund or confirm once. A ticket scanned twice at the Gate keeps one set of faces, and Take again replaces the gate's earlier shot.

`src/account/backend.ts` defines `AccountBackend`. `createLocalBackend` keeps accounts, password hashes (PBKDF2, `src/account/password.ts`), sessions and idempotency records in this browser's localStorage. In this build, codes work only in the browser that made them. For production, implement the same interface on a server that owns accounts, issues sessions per device and enforces roles. Swap it in at `createLocalBackend(browserStore())` in `src/main.ts`.

## Screens

The shell follows the house UI style: a soft grey canvas, borderless white cards, one ink surface and one coral accent. Desktop and tablet get a floating dark rail; phones get a floating dark bottom bar with Dashboard, Try on, the capture button, Photobooth and More, which opens a sheet holding Gallery and Locations. The round accent button in either one takes a snapshot on **Try on**, starts a run on **Photobooth**, and returns to the camera from **Gallery** and **Locations**.

- **Dashboard** sums up the captures saved on this device over the last 7 or 30 days (the switch is remembered). A dark hero card leads with the total, the change against the period before, and a column per day with today in the accent; hovering or focusing a column shows its date and count, and a hidden table carries the same numbers for screen readers. Beside it, a **Needs attention** card turns coral when something needs a person: the trial ends within 3 days, there are no locations or points yet, this device is not linked to a point, or an active point captured nothing in the period. Each item has a button that goes to the fix. Below sit stat cards (snapshots, photobooth sheets, active points, locations), **Top points** and **By location** ranked with bars, and the six most recent captures with the point that took them. `src/dashboard-stats.ts` does the counting (tested) and `src/dashboard-view.ts` draws it. A device with no point opens on the dashboard after sign-in; a kiosk linked to a point opens on Try on.
- **Try on** holds the camera and the Wear card: category tabs, the first six items with "Show all", the Size slider, Upload PNG and Snapshot. Hold up ✌️ for a 3 second snapshot countdown. Snapshots go to the gallery.
- **Photobooth** is one card with a four-step flow, so the panel stays short: **Layout** (strip, 2x2 grid or single, each drawn as a small diagram), **Background** (two modes, **Swap background** and **AI blend**, each over a **Scenery** tab of six landscape photos and a **Studio** tab with blur, painted backdrops or your own photo; with a mouse, hovering a tile previews it on the camera before you click), **Stickers** (emoji and text badges you drag on the camera) and **Print** (frame colour, timer, caption, then Start). The steps are clickable at any time, Back and Continue walk them in order, and a line under the card gives the shot count and run length. A preview of the sheet as it would print sits in a corner of the camera through every step, redrawn when a setting changes and every second to follow the camera. Start runs a countdown before each shot, flashes, prints the sheet and shows it in the same card with Download, Gallery and New sheet. Hold up ✌️ to start hands-free; the run will not restart until the hand drops.
- The camera card takes the shape of the camera's own video once it reports its size, so a landscape webcam on a phone does not leave tall black bars that push the controls off screen.
- **Gallery** lists every snapshot and sheet, newest first, with download and a two-tap delete.
- **Locations** is the master data. A location is a store, mall or venue, and each one holds its points: the kiosks, mirrors and booths that run the app. Each location card lists its points with code and status, and a footer counts points, active points and captures. Adding a location goes straight on to its first point. A point's code is suggested from the location name (GRA-01, GRA-02) and must be unique across the account. Pausing a point keeps it listed but takes it out of the device picker. Deleting a location asks first and removes its points; captures already saved stay in the gallery. The Add buttons turn off at the trial limits. Search matches location names, cities, addresses, point names and codes. A **Cards | Table** switch next to search picks the layout, and the device remembers it. The table lists every point under a header row for its location, with code, status, captures and actions; clicking a row opens the point. On phones the table drops the code and captures columns, shows the code under the name, and shrinks the status to its dot, so it fits 375 px without scrolling sideways.
- **This device** (the card above the Try on and Photobooth panels) says which point the device runs as. Every snapshot and sheet saved there carries that point, the gallery shows it under the date, and the Locations page counts captures per point. The choice is stored per device and per account, since each kiosk sets its own.
- **Share** (on a finished photobooth sheet, and on every gallery card) lays the capture out for Instagram: **Post** 4:5 at 1080 x 1350, the tallest shape the feed shows uncropped; **Square** 1080 x 1080; **Story** 9:16 at 1080 x 1920; or **Original**. The picture sits whole inside the frame over a blur of itself, or over plain Paper or Ink. Stories keep the top 250 px and bottom 280 px clear, where Instagram draws the profile row and the reply field. **Share** hands the file to the phone's own share sheet through the Web Share API, which is how a web page reaches Instagram, WhatsApp and the rest; browsers without file sharing hide it and make **Save** the main action. **Copy** puts a PNG on the clipboard for pasting into web apps. Social sizes save as JPEG at 92% quality, since Instagram recompresses uploads anyway; Original stays PNG. `src/social.ts` holds the sizes and the layout math (tested); `src/share-dialog.ts` is the sheet, a centred dialog on desktop and a bottom sheet with pinned actions on phones.
- **Hand control** (the hand button in the header) lets you work the app from a step back. The point between your thumb tip and index tip moves a cursor over the whole screen, a pinch clicks, and a pinch held while moving drags, which is how stickers move. ✌️ still captures: a snapshot countdown on Try on, a photobooth run on Photobooth. The same gesture recognizer supplies both the gesture and the 21 hand landmarks, so the cursor costs no extra model. A comfortable arm movement covers the screen because only the middle of the camera frame maps onto it (`REACH` in `src/hand-cursor.ts`). Browsers only open a file picker for a real click, so Upload still needs the mouse.

The scenery photos come from Wikimedia Commons and are each released as CC0 or public domain, so they need no permission or credit: Serene Tropical Beach with Lush Greenery, Nagari tuo Pariangan (West Sumatra), Forest Away Path, Lake Mountain Landscape, Mirror Lake and the Beartooth Mountains, and Absaroka Range with alpenglow. The app loads the 1280 px renditions on first use, so none of them live in the repository; Commons serves them with open CORS headers, which keeps captured frames exportable.

`src/photobooth.ts` holds the sheet geometry (tested), the compositing and the timed run. `src/render/background-layer.ts` draws the backdrop over the video with a hole where the segmenter found the person, so the live camera shows through; the mask is feathered at mask resolution, where a 1 px blur is cheap. `src/stickers.ts` keeps the stickers in a layer outside the mirrored stage, maps their positions through the `object-fit: contain` letterboxing, and stamps them onto each captured frame. `src/gallery.ts` stores captures in IndexedDB and falls back to memory when the browser refuses storage.

## Booth business

Everything a photobooth operator runs beside the camera: the customer's session at the booth, payments, the cashier, the queue, the owner's dashboard, and device health. It runs in this browser build today. The parts a browser cannot reach (the Canon and DNP SDKs, a payment gateway's server key, OTA and remote-access agents, email and WhatsApp) sit behind adapters with simulators, listed under [Going to production](#going-to-production).

The rail holds Dashboard, Booth, AI presets, Point of sale, Queue, Try on, Photobooth and Gallery. **More** opens every page, grouped the way a venue works:

| Group | Pages |
|---|---|
| Serve customers | Booth, AI presets, Gate, Queue, Point of sale |
| Studio | Try on, Photobooth, Gallery, Faces |
| Sales and reports | Reports, Transactions, Activity history, Vouchers |
| Setup | Setup guide, Locations and booths, Cameras, printers and alerts, Payments, Prices and rules, Frames, Branding |
| Team and access | Users, Roles and permissions, Sign-in log |
| System | Fleet and support |

**Setup guide** walks a new venue through nine steps in four stages (Venue, Selling, Hardware, Look and team): locations and booths, linking the device, each booth's category and prices, the payment gateway, a camera and a printer per booth, then brand, frames and team. Each step ticks itself off from the data, says what is still missing ("No printer: Booth 2"), and opens the form it needs: the camera step goes straight to the camera setup of the first booth without one, the prices step to the Booths part of Prices and rules. Optional steps (device link, brand, frames, team) never hold up "ready to open". The dashboard shows the progress until every required step is done. **Prices and rules** carries a sticky jump bar over its eight parts. On phones the bottom bar holds Dashboard, Booth and Queue around the capture button. A device linked to a booth opens on the Booth flow; any other device opens on the Dashboard.

### Booth client

- **Booth flow** (the Booth page, beside the camera): pick a mode, pay, choose a frame and a look, shoot, print, then scan the QR for the soft files. Free sessions skip payment in the progress count. Before payment, customers can change modes; after payment, the Look step offers staff help so the paid order stays available for review. A failed capture can be retried within the same session. Five modes, each priced per booth category in Settings: **photo strip**, **GIF** (a 12-frame boomerang, encoded in `src/ops/encoders.ts`), **video booth** (an 8 second clip), **live photo** (a still plus a 3 second clip) and **original / vintage** (a single film-toned print).
- **Effects:** filters (Natural, Mono, Warm, Cool, Vintage, Vivid), brightness, contrast and colour, mirror on or off, and zoom by slider or by pinching the camera. The preview shows them live, and `applyEffects` bakes the same values into every captured frame.
- **Capture engine:** each booth has a preview profile and a capture profile (ISO, aperture, shutter, white balance, exposure compensation, picture style), set on Devices → Cameras. The capture profile goes on for the shot, then preview comes back. Drivers re-apply the saved preview profile when the camera powers up. `WebcamDriver` maps what a webcam can take onto its track; `DslrDriver` sends them to a real DSLR; `SimulatedEdsdk` stands in for a camera, with power and battery controls on the Cameras tab.
- **DSLR by IP address** (Devices → Cameras → **Set up**): pick how the camera connects, type its IP address, and **Test connection** reads the model and battery and shows a live view frame. Two ways in: **Canon over Wi-Fi or LAN** through CCAPI, which Canon bodies such as the EOS R series, 90D and M50 Mark II carry once activated with Canon's free tool (port 8080), and **DSLR over USB** through digiCamControl's web server on a Windows PC, for Canon and Nikon (port 5513). Then choose what the booth uses it for: live view as the preview, photos from the DSLR at full resolution, the preview and capture profiles sent to the body, focus before each shot, and the battery on Devices with a low-battery alert. Anything the camera cannot do stays off. GIF and video still record the live view. When a DSLR shot fails, the booth uses the preview frame and tells staff why. Cameras send no CORS headers, so the page reaches them through `/api/camera/<ip>:<port>/…` on the booth server (`scripts/camera-proxy.mjs`, in both `pnpm serve` and `pnpm dev`); it answers only the booth computer itself and forwards only to private network addresses. `node scripts/fake-ccapi.mjs` runs a simulated Canon on port 8080 (`PORT=` to change it) for trying the setup without a camera.
- **Behind-the-scenes camera:** pick a second camera per booth, and every session records a BTS clip from it, saved with the session.
- **Printing:** sizes 2R, 3R, 4R, 5R, 6R, 8R, A4, A3, panoramic and custom. A booth can have several printers, and one printer can serve several booths. Each job goes to a working printer at that booth that takes the size and has paper, the fullest first. Printing uses the browser's print queue with the page size set, so Chrome started with `--kiosk-printing` prints without a dialog. Customers can buy extra prints before the session (on the pay step) or after it (Buy prints, by QRIS).
- **Offline queue:** every sale, session, refund and shift is written to a local outbox first and only leaves when the cloud acknowledges it, in order, with exponential backoff. A reconnect or "Sync now" retries at once. Fleet → Cloud sync has a "Simulate offline" switch to try it.
- **Idle-screen ads:** upload images or clips in Settings and switch them on; a booth waiting on its start screen plays them after the idle time, and a tap returns to the start.
- **OTA updates:** Fleet → Releases stages a version to a share of booths. Each booth's bucket is fixed per release, so widening a rollout only adds booths. A rollback sends a release's booths back to the version below it.
- **Remote support:** a booth requests support and shows a six-digit code. The operator allows the connection, and every session is logged.

### Payments

- **QRIS:** the booth and the till show a dynamic QR for the amount due. The gateway's callback marks the payment paid, which unlocks the session or completes the sale. The simulator builds an EMVCo-shaped payload marked SIMULATOR, and a "Simulate payment" button stands in for the customer's bank app.
- **Cash, card and e-wallet:** cash at the till with change, and card or e-wallet with the EDC approval code or the e-wallet reference.
- **Vouchers:** single-session codes, multi-booth codes with a use limit, date windows and happy hours checked on each booth's own time zone, frames only a code unlocks, free event mode (every session at the listed booths is free while it runs), and batches of single-use codes exported to CSV. Every session sold at the till prints its own single-use code.
- **Managing payments** (More → Payments): every customer payment from the till and the booths in one list, with its status (waiting, paid, expired, failed, cancelled), the method and the wallet or terminal it went through, the reference, the amount and the fee. Filters by status, method, till or booth, branch and text; totals for paid, fees, net and open QRs; CSV export. Opening a waiting QR shows it again and offers two actions: **Cancel QR** with a reason, for a customer who walked away, and **Mark paid** with the bank's reference and a supervisor's PIN, for a payment the bank app shows as done but the gateway never reported. Both go on the activity log. QRs expire on their own after the time set for the gateway; the till and the booth count it down and offer a new QR when it runs out or is cancelled.
- **Payment settings** (the other tabs on the Payments page, for owners and admins): **Methods and fees** switches each method on or off at the till and at the booth, and sets its processing fee, which is recorded on every payment at the rate of the day; **QRIS gateway** picks Midtrans, Xendit or DOKU, sandbox or production, the merchant ID, the browser-safe client key (a server key is refused) and how long a QR stays valid; **Terminals and e-wallets** lists the EDC machines per branch and the wallet brands the till can pick. `src/ops/payments.ts` holds the rules (tested).
- **Settlement:** Reports → Settlement reads the gateway's settlement export and matches it against the QRIS payments recorded here. It shows matches, amount differences, payments only the gateway has, and payments that never settled, plus fees.

### Digital delivery

- **Soft files:** the QR at the end of a session opens the customer's page with every photo, GIF and clip, single downloads, "Download all" (a ZIP), and Share, which hands the file to the phone's share sheet for Instagram and TikTok.
- **Branded page:** logo, colours, a heading and social links, edited on Branding with a live preview. On the local HTTP photo server, customers download files and can share them from their phone's photo app. A hosted HTTPS page can offer the phone's Share sheet after the customer agrees to sharing.
- **Links:** the local QR points to the booth computer on the same network. The current browser build records email notifications but has no email sender, so the booth does not ask customers for an email address. Per-event gallery pages collect sessions whose customers opted in.
- **Retention:** photos older than the retention period (Settings, default 30 days) are deleted on start and every six hours. The sales record stays.

### POS / cashier

- **One cart** for sessions per booth category, extra prints, merchandise with stock, and paid reprints of past photos. Discount presets need the discount permission.
- **Receipt:** prints at 80 mm or goes by email, with the per-session codes and the queue number.
- **Refunds:** per item, with a reason and a supervisor's PIN. Each refund goes on the audit log, puts merchandise back in stock, and voids an unused session code.
- **Shifts** (optional, in Settings): open with a cash count, close with the drawer count. The slip shows gross, refunds, net, each payment method, expected cash and the difference.
- **Customer screen:** "Customer screen" opens a second window with the live cart, a large QRIS and the queue number after payment.

### Queue

- Tickets carry a number and a QR. Booked customers check themselves in by scanning it.
- One ticket can wait for several booths. The first free booth calls it, and it leaves every other line, so nobody is called twice.
- Operators can drag to reorder, re-call a ticket (it flashes on the TV), mark a no-show, and put a late customer back at the front or the back.
- A customer who leaves a WhatsApp number or email gets a message when called. "TV display" opens the waiting-area screen.

### Cloud dashboard

- **Dashboard:** today's revenue per branch and booth, booths online, open alerts, the queue and items waiting to sync, above the capture charts.
- **Transactions:** orders with per-line refunds, booth sessions, refunds, shifts with their slips, and the activity log of every sale, refund, voucher, shift, alert and setting change.
- **Frames:** upload a PNG with transparent windows. Smart Frame finds each window and the shots fill them in reading order. Frames have categories and session counts.
- **Reports** (Sales and reports → Reports): one date range (Today, 7 days, 30 days, This month or custom dates) for six tabs. **Sales** groups revenue by day, branch, booth, shift, frame or mode. **Products** splits it into photo sessions, AI presets (booth panel and kiosk), extra prints, reprints and merchandise with each one's share of net, refunds landing on the line given back, plus the ten best sellers. **Payments** shows each method, day, branch, booth or shift with the count, gross, processing fees, refunds and net. **Cash** lists each shift's drawer: opening cash, cash in, cash refunds, expected, counted and the difference. **Floor** counts tickets served and skipped, the average wait from ticket to call, the parties the gate photographed, AI prints sold per photographed party, and tickets by hour with the busiest hour marked. **Settlement** matches a gateway export (below). Every table exports to CSV; Sales, Products and Payments also to XLSX (`xlsx` in `src/ops/encoders.ts` writes a real workbook).
- **Roles:** owner, admin, supervisor, cashier and booth operator. A person with branches listed only sees those branches. Switching user on a device takes the person's PIN.

### Device telemetry and alerts

- The device linked to a booth sends a heartbeat every 30 seconds with its camera state and version. A booth silent for two minutes shows as offline.
- Alerts open once per problem and resolve on their own: low paper (DNP reads its count from the SDK; other brands count down from a manual count), printer errors, a disconnected camera, a low camera battery, and an offline booth.
- With no rule, an alert pops up on the booth and goes by email and WhatsApp to the owner and the staff on duty at that branch. Branch rules on Devices → Alert routing narrow the channels and the people. Messages sent lists every email and WhatsApp the app produced.

### Cameras and AI presets

- **Camera source:** the camera button on the stage, or Devices → Cameras → Camera source, picks this device's picture: the default camera, any USB or built-in camera by name, or an **IP camera** by link. An MJPEG link streams through an image; an HLS, MP4 or WebM link plays through a video element. Either way, `src/camera-source.ts` turns the picture into a normal camera stream, so try-on, recording, face capture and Decart all work on it. Browsers cannot open RTSP, so an RTSP camera goes through a bridge such as go2rtc or MediaMTX, which serves it as MJPEG or HLS (`http://bridge:1984/api/stream.mjpeg?src=booth1`). The camera or the bridge must send CORS headers (go2rtc: `api: origin: "*"`), or the browser hides the pixels and the app says so. The choice is saved per device.
- **AI presets** (rail → AI presets): the customer taps **Capture my face**, and after a 3 second countdown the face tracker crops a 4:5 headshot (`src/faces.ts`). The **Faces** page then lists every face captured on this device, newest first, with the new one picked. Tap to pick one or several, or Select all, or delete a face. **Templates** shows every active preset already filled with the picked faces, plus every active frame from the Frames page with the faces in its windows. It suggests one: Squad for several faces, else the first single-face layout. Picking a template opens it large. **Make it with AI** sends it to Decart's image model with the preset's prompt, keeping every face as it is, and the result can be saved to the gallery, shared in the Instagram sizes, or printed.
- **Gate to print, as a party** (rail → Gate on the device at the entrance, with a CCTV as its camera source): staff scan the ticket QR or type its number, a USB scanner works as a keyboard, and the camera photographs everyone standing there, up to six faces in one shot (`detectFaces` in `src/tracking/face.ts`). Each face is filed under the ticket, and a ticket that checks in from a phone while the Gate screen is open is photographed the same way. At the booth, AI presets opens with **Continue as A007** when the queue has called that ticket here, or with a box to type the number; the party's faces come first, already picked, and the customer taps who is in the picture and drops who is not. After the template, **Pay** takes QRIS (or a voucher or receipt code) for the price set under Settings → Print prices → AI preset, the order shows as "AI preset · Squad" in Transactions and the reports, and the result page prints on the booth's printer. Setting the price to 0 keeps the presets free and skips the pay step.
- **Self-service kiosk** (Queue → Self-service kiosk, or `#display=kiosk&booth=<id>`): the same party flow on a touch screen with no staff at it, in Bahasa Indonesia. The visitor scans the ticket QR on a USB scanner or types the number on a big keypad, taps who goes into the picture, picks a template, pays with QRIS or a voucher, and the print comes out of the booth's printer. The kiosk shows only the faces the gate took for that ticket, and goes back to the start 90 seconds after the last touch (25 seconds after the print), voiding an unpaid order on the way. A waiting QR or a print in progress holds the timer. The kiosk tab opens from the staff tab and inherits its Decart key, so the AI redraws the template before it prints; without a key it prints the template. When the printer fails, the screen gives the visitor the order number to show staff.
- **Locked screens:** the TV display, the customer screen and the kiosk open locked from their staff buttons (`&lock=1` in the link). A locked tab goes back to its screen after a reload, a typed address or the Back button. Staff unlock it from the small lock in the corner with the email and password of an active team member; wrong passwords count toward the same 15 minute lock as sign-in, and the Sign-in log records each unlock. Unlocked, the corner offers **Kunci layar** and **Buka aplikasi staf**. The lock lives in that tab's sessionStorage, so a staff tab in the same browser stays free. Run kiosk and TV browsers full screen (Chrome `--kiosk`) so visitors cannot close the tab.
- **Naming faces:** tap any face, at the Gate, under the faces at the booth, or on the **Faces** page (rail → Faces), to open the tag panel: the face large, a name box that suggests the ticket's name and names used before, and the ticket, place and time it was taken. Names show under each face at the booth. The Faces page lists every face kept with its name, filters All, No name and Named, and searches by name or ticket number. Deleting a face, from the panel, deletes its name with it, and retention deletes both after the photo window (`src/ops/face-tags.ts`).
- **Presets:** five built-in layouts, drawn on the device at 1080 × 1350 (`src/ops/presets.ts`): magazine cover, Polaroid, movie poster, VIP pass, and a squad page for up to four faces. Owners edit prompts, switch presets off and add their own (any layout, or an uploaded frame) under Frames → AI presets.
- **Face list and privacy:** Settings → Operations → "Face list" chooses between every face captured (as asked, so regulars can reuse theirs) and only the current customer's faces. A public booth should use the second, since the first shows every customer's face to the next one. Captured faces follow the photo retention window and are deleted with the photos.

### Code

`src/ops/` holds the business: `model.ts` (every record), engines with tests (`vouchers`, `cart`, `shift`, `queue`, `outbox`, `printing`, `telemetry`, `access`, `fleet`, `reports`, `encoders`, `frames`), `adapters.ts` (the edges and their simulators), `store.ts` (one JSON document per workspace with an activity log, broadcast to other windows), `ops.ts` (every action, logged and queued for sync), `capture.ts` (effects, GIF bursts, clips), and `ui/` (the pages, the Booth flow and the standalone screens). `src/ops/ops.test.ts` runs a day at the till end to end.

### Going to production

**Booth computer setup**

1. `pnpm install`, then `pnpm models` once while the computer has internet. The camera then loads the face, pose, hand and background models from the booth itself; without the copies it falls back to Google's servers.
2. `pnpm build`, then `pnpm serve`. Keep the server running with the OS's service manager (launchd, systemd or NSSM on Windows) so it restarts after a reboot.
3. Open `http://127.0.0.1:4173` on the booth and sign in. Open the kiosk and the TV from **Queue** so they start locked.
4. Run the kiosk and TV browsers full screen, for example `chrome --kiosk --kiosk-printing http://127.0.0.1:4173/#display=queue&lock=1`. Turn off the OS screen sleep: the Wake Lock API that keeps screens on needs HTTPS or localhost.

**What the build does for production**

- *Two bundles.* The TV, customer screen, kiosk, check-in and photo pages load about 60 kB (gzip) without the camera, MediaPipe or the Decart SDK. The staff app loads about 145 kB first; the Decart SDK and LiveKit (another 180 kB gzip) load only when someone turns on AI mode or an AI print.
- *The server* compresses HTML, JS, CSS and the wasm runtime with brotli or gzip (the 11.7 MB wasm goes out as 2.7 MB), caches hashed bundles for a year, revalidates everything else (`index.html`, the wasm runtime, models, icons) with an ETag so an unchanged file costs a 304 and a new runtime never meets an old bundle, and sends `nosniff`, `SAMEORIGIN`, `no-referrer` and a camera-only Permissions-Policy.
- *Unattended screens* keep the screen awake, block pinch zoom, long-press menus and text selection, and reload themselves: the TV and customer screen 10 seconds after an uncaught error and every 6 hours, the kiosk at its start screen once it has run 6 hours.
- *The staff app* shows any uncaught error as a notice, once per message a minute.
- *Payments are safe to repeat.* A double tap on Pay shares one QRIS charge, and a QR still waiting for the same amount shows again instead of a new one. A repeated gateway callback changes nothing. A late callback for a QR this device had expired still settles an open order, and once an order is paid any other QR for it closes so nobody pays twice. Kiosk buttons rest while their work runs.
- *Demo items* from dummyjson.com and Wikimedia appear only in development. Set `VITE_DEMO_CATALOG=1` at build time to keep them.
- *DM Sans* ships inside the bundle (`src/assets/fonts`, SIL Open Font License), so screens keep their typeface without internet.
- A web manifest and icon let a tablet add the app to its home screen.

**Still to replace before a public launch**


| In this build | For production |
|---|---|
| `SimulatedGateway` builds a QRIS-shaped payload; "Simulate payment" stands in for the bank | A server that creates the charge with the Midtrans, Xendit or DOKU server key and pushes its payment callback to the booth that showed the QR |
| DSLRs connect over CCAPI or digiCamControl; `SimulatedEdsdk` stands in when there is none | Canon CCAPI and digiCamControl work today; Canon bodies without CCAPI over USB need a native EDSDK bridge implementing `CameraDriver` |
| DNP paper is read from a manual entry | The same bridge reads DNP's SDK and writes `paperLeft` |
| `printImage` uses the browser print queue | Chrome with `--kiosk-printing`, or the native bridge sending jobs to the printer driver |
| `SimulatedCloud` acknowledges the outbox locally | The cloud API the outbox posts to, deduplicating by item id |
| Emails and WhatsApp messages are listed on Devices → Messages sent | An email provider and the WhatsApp Business API sending them |
| The local photo server lets phones on the booth network open files; the Vite preview has no shared files | A cloud service with object storage and a public domain for access outside the venue |
| Releases and support sessions are recorded | An update agent that installs the target version between sessions, and a remote-access agent (such as RustDesk) that takes the code |
| Staff PINs are PBKDF2 hashes in this browser | Accounts and PINs on the server, with sessions per device |

## Two modes

**On device** is the default and everything below describes it. It runs entirely in the browser, costs nothing and sends no video anywhere.

**Decart AI** streams the camera to Decart's hosted try-on model and plays the generated video that comes back. The model repaints every frame with the garment worn, so it renders folds, shadows and body rotation, and it covers the clothes you already have on. A geometric overlay cannot do any of that. It needs your own API key, it bills per second of streaming, and your camera leaves the machine while it runs. `src/decart.ts` holds the session: `client.realtime.connect(stream, ...)` with the `lucy-vton-latest` model, then `setImage(url, { prompt })` per garment, which switches clothes without reconnecting.

The key is read from a field and kept in `sessionStorage`, so it never reaches disk and disappears when the tab closes. Decart's own guidance for a public deployment is different: keep the permanent key on a server and hand the browser short-lived client tokens from `client.tokens.create()`, which expire after ten minutes. This app has no server, so it takes the key directly.

Decart AI mode changes clothing only. Glasses and hats stay in on-device mode.

### Photobooth AI blend

The photobooth's Background step has two modes. **Swap background** is the on-device cut described below: the segmenter finds the person and the backdrop fills everything else, live and free. **AI blend** starts from that same shot, the person already cut onto the backdrop, and sends it to Decart's `lucy-image-2` image editor together with the backdrop picture as the reference. Decart redraws the shot so the person sits in the scene, with its light, shadows and colour, and cleaner edges than a mask gives. The prompt asks it to keep the face, hair, expression, pose and clothing unchanged.

Each blend starts the moment its shot is taken, so Decart works through the next countdown, and the sheet prints once every shot is back. Stickers go on after the blend, so the model never redraws them. The result is fitted back to the shot's size before the sheet crops it. AI blend needs a backdrop (Blur sends no reference picture) and a Decart API key, which it shares with Try on's Decart field through `sessionStorage`. Decart bills per image, a four-shot sheet makes four requests, and the photos leave the device. `blendIntoScene` in `src/decart.ts` holds the request and the prompt.

## How it works

- `src/tracking/face.ts` runs the Face Landmarker for glasses and hats. `src/tracking/pose.ts` runs the Pose Landmarker for clothing. A detector runs only while an item that needs it is worn, and each is created on first use and kept alive.
- `src/tracking/gesture.ts` runs the Gesture Recognizer every frame. `src/capture-trigger.ts` turns a peace sign held for 8 frames into a 3 second countdown, fires one capture, then ignores gestures for 3 seconds. The trigger gesture and timings are set where `CaptureTrigger` is constructed in `src/main.ts`.
- `src/anchors.ts` turns face landmarks into a head frame for glasses and hats: an origin plus the head's right and down axes projected onto the image. The axes come from the 3D landmarks (the eye line and the chin-to-forehead line), so when the head turns the right axis shortens and the item foreshortens with the face, and when it nods the down axis does; a tilt rotates both. The reference width is measured in 3D, so a hat does not shrink as the head turns. Glasses sit between outer eye corners 33 and 263; hats start at forehead point 10 with width from head sides 234 and 454. `src/render/overlay.ts` draws the item along those axes with one canvas transform.
- Every frame passes through a One Euro filter (`src/filter.ts`, tested): a low-pass whose cutoff rises with speed, so an item stops shaking while the wearer holds still and still follows a quick turn without lag. The garment controls go through the same filter.
- Glasses and hats cast a shadow: the item's silhouette dropped a little down the head's axis, blurred, and clipped to the face oval so it lands on the forehead and never on the wall behind. They also take the room's light through the same soft-light shading the garment gets (`src/render/shade.ts`).
- Clothing follows the body instead of sitting rigid. `src/garment.ts` reads the garment's own outline to find its shoulder seam, hip line and cuffs, then pairs those with the pose skeleton. `src/mls.ts` builds a Moving Least Squares deformation from those pairs, and `src/render/warp.ts` redraws the photo as a triangle mesh through it. The garment then leans, turns and stretches with the torso, and its sleeves travel down the arms toward the elbows and wrists.
- Three rules keep the size honest. The shoulder seam alone sets the scale, so the garment is exactly `scale` times the pose shoulder span. The torso mapping stays a rotation plus uniform scale, so the body supplies only the lean and a short torso wears the same garment lower rather than squashing it. The collar top is pinned just above the shoulder line, because a photo lays the collar and shoulder slope out flat and that band would otherwise ride up over the chin.
- Pose shoulder landmarks mark the joint centers, which sit well inside the shoulder outline, so the clothing default reaches about half again as wide (`scale` 1.45). The Size slider trims that live per category and covers the rest of the variation between builds and camera distances.
- Both axes of the deformation work in texture pixels rather than 0 to 1 coordinates. A similarity in a squashed coordinate space is not a similarity on screen, and that mismatch showed up as garments that were too wide for their height.
- A cuff only follows an arm when the photo shows the sleeve spread out, which `measureGarment` decides by comparing the widest point above mid height against the body below it. A shirt photographed with its sleeves hanging down the sides keeps to the torso, which avoids smearing it sideways.
- The garment is trimmed to the wearer's outline, which is what stops it reading as a sticker. `src/tracking/segmenter.ts` runs the selfie multiclass segmenter, and `src/render/occlusion.ts` turns its per-pixel classes into the silhouette the garment may occupy: the person, minus hair, face and accessories, minus bare skin that falls inside the torso. Nothing spills onto the room behind, and a hand raised to the chest passes in front of the shirt. Skin outside the torso stays available so the sleeves keep wrapping the arms they are drawn on.
- Because the outline does the trimming, `scale` only has to be generous enough to cover the body. Excess width is clipped away rather than hanging off the shoulders, so the setting is forgiving in one direction and not the other.
- `src/render/garment-layer.ts` composites the result. It warps the photo, blends a blurred grayscale copy of the frame over it with `soft-light` so the garment picks up the room's light and the body's shading, darkens a soft ellipse under the chin where the head shades the collar, then punches out the cutout with a 1 px feather at mask resolution.
- The occlusion keeps the neck and the upper chest, down to 0.3 shoulder spans below the shoulder line, under the collar: skin and jewellery there stay covered, so a neckline or a necklace in the camera does not punch a hole in the shirt, while a hand raised lower on the chest still passes in front.
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

Hats are real photos from Wikimedia Commons, listed as `COMMONS_HATS` in `src/store-catalog.ts`: a baseball cap, fedora, flat cap, bobble hat, top hat and straw hat. Most were shot on a plain white, grey or beige backdrop. `clearBackdrop` in `src/image-bounds.ts` (tested) makes that backdrop transparent when the image loads: it flood-fills from the border through pixels close to the border colour and to their neighbour, so soft shadows go and the hat's own edge stops the fill, then keeps only the largest shape, which drops museum labels. Photos that already carry transparency, or whose border is busy, pass through untouched. The item tiles show the same cutout. Each hat has its own `scale` and `offsetY`, tuned on a front-facing portrait so the brim sits across the forehead.

The hat photos need a credit, which each item's tooltip carries:

| Hat | Commons file | Credit | License |
|---|---|---|---|
| Baseball cap | Baseball cap.png | TexasRebel, background removed by ReneeWrites | CC BY 4.0 |
| Fedora | Herrenhut breitkrempig 03 (fcm).jpg | Frank C. Müller, edited by Rainer Zenz | CC BY-SA 2.5 |
| Flat cap | Hat MET 29.158.485 S.jpg | The Metropolitan Museum of Art | CC0 |
| Bobble hat | Mössa - Nordiska museet - NM.0050303.jpg | Elisabeth Eriksson, Nordiska museet | CC BY 4.0 |
| Top hat | Collapsible top hat IMGP9647.jpg | Nikodem Nijaki | CC BY-SA 3.0 |
| Straw hat | Straw hat, Vietnamese Women's Museum.jpg | Vietnamese Women's Museum | CC BY-SA 3.0 |

File pages sit at commons.wikimedia.org/wiki/File:<name>.

## Adding items

Drop a transparent PNG, or a photo on a plain backdrop, into `public/items` and add an entry to `DEFAULT_ITEMS` in `src/catalog.ts`. For glasses and hats, tune `scale` first, then `offsetY`. Clothing needs no tuning: photograph the garment flat and facing the camera, and the warp sizes it from its own shoulder line. Users can also press Upload PNG to try any transparent PNG in the current category without a code change. Tapping a worn item in the strip takes it off.
