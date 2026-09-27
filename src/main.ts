import './style.css';
import type { FaceLandmarker, GestureRecognizer, ImageSegmenter, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision';
import { faceOutline, glassesFrame, hatFrame, itemRect, packFrame, unpackFrame, type HeadFrame } from './anchors';
import { CAMERA_MESSAGES, classifyCameraError, startCamera } from './camera';
import { CaptureTrigger, type TriggerState } from './capture-trigger';
import { DEFAULT_ITEMS, createUploadItem, loadImage, placementOf, type CatalogItem, type Category, type ItemImage } from './catalog';
import { DEBUG, drawLandmarkDots } from './debug';
import { CONTROL, NOMINAL_SHAPE, garmentControls, readBody, torsoQuad } from './garment';
import { OneEuroFilter } from './filter';
import { mlsSimilarity, type ControlPair, type Vec } from './mls';
import { GarmentLayer } from './render/garment-layer';
import { Overlay, canvasToBlob, captureFrame, type ItemShadow } from './render/overlay';
import { detectFace, getFaceLandmarker } from './tracking/face';
import { NO_HAND, getGestureRecognizer, readHand } from './tracking/gesture';
import { HandCursor } from './hand-cursor';
import { detectPose, getPoseLandmarker } from './tracking/pose';
import { getSegmenter, segmentForVideo, type SegmentMask } from './tracking/segmenter';
import { nextTimestamp } from './tracking/vision';
import { COMMONS_HATS, loadStoreCatalog } from './store-catalog';
import { CAMERA_VIEWS, mountUi, type Mode, type StatusKind, type View } from './ui';
import { mountBoothPanel } from './booth-panel';
import { NO_BACKGROUND, drawBackdrop, type Background } from './backgrounds';
import { BackgroundLayer } from './render/background-layer';
import { StickerLayer, drawStickers, type PlacedSticker } from './stickers';
import { coverCrop } from './fit';
import { countByPoint, saveShot } from './gallery';
import { mountGalleryView } from './gallery-view';
import { mountShareDialog } from './share-dialog';
import { composeBooth, runBoothSession, shotsFor } from './photobooth';
import { blendIntoScene, connect as connectDecart, readStoredKey, storeKey, wearGarment } from './decart';
import type { RealTimeClient } from '@decartai/sdk';
import { browserStore, createLocalBackend } from './account/backend';
import { mountAccountButton, signedIn } from './auth-screen';
import { mountSitesView, type SitesView } from './sites-view';
import { mountDashboard, type DashboardView } from './dashboard-view';

/** One Euro settings for landmarks in pixels: steady while the wearer holds still, quick to follow a turn. */
const TRACK_FILTER = { minCutoff: 1.2, beta: 0.01 };
const LOST_FRAME_GRACE = 8;
/** Frames between segmentation passes. The body silhouette drifts slowly next to the landmarks. */
const SEGMENT_EVERY = 2;
const MESH_COLUMNS = 8;
const MESH_ROWS = 10;

/** Back to front, so hats cover glasses and both sit over clothing. */
const DRAW_ORDER: readonly Category[] = ['clothing', 'glasses', 'hat'];

type RigidCategory = 'glasses' | 'hat';
type Detector = 'face' | 'pose';

const DETECTOR_OF: Record<Category, Detector> = { glasses: 'face', hat: 'face', clothing: 'pose' };
const FRAME_OF: Record<RigidCategory, (lm: NormalizedLandmark[], w: number, h: number) => HeadFrame> = {
  glasses: glassesFrame,
  hat: hatFrame,
};
/** The shadow each item casts on the face, in frame widths: a brim falls further than a pair of frames. */
const SHADOW_OF: Record<RigidCategory, ItemShadow> = {
  glasses: { drop: 0.03, blur: 0.02, alpha: 0.25 },
  hat: { drop: 0.06, blur: 0.05, alpha: 0.35 },
};
const frameFilters: Record<RigidCategory, OneEuroFilter> = {
  glasses: new OneEuroFilter(TRACK_FILTER),
  hat: new OneEuroFilter(TRACK_FILTER),
};
const garmentFilter = new OneEuroFilter(TRACK_FILTER);

const video = document.querySelector<HTMLVideoElement>('#cam')!;
const remoteVideo = document.querySelector<HTMLVideoElement>('#remote')!;
const overlay = new Overlay(document.querySelector<HTMLCanvasElement>('#overlay')!);
const garmentLayer = new GarmentLayer();
const handCursor = new HandCursor();
const backgroundLayer = new BackgroundLayer();
const stickers = new StickerLayer(document.querySelector<HTMLElement>('.stage-card')!, () => visibleVideo());
/** ✌️ in Try on: a 3 second countdown, then one snapshot. */
const snapTrigger = new CaptureTrigger({ gestures: ['Victory'], holdFrames: 8, countdownMs: 3000, cooldownMs: 3000 });
/** ✌️ in Photobooth: start at once, since every shot already has its own countdown. */
const boothTrigger = new CaptureTrigger({ gestures: ['Victory'], holdFrames: 8, countdownMs: 0, cooldownMs: 1000 });

const state = {
  activeTab: 'glasses' as Category,
  items: [...COMMONS_HATS, ...DEFAULT_ITEMS],
  worn: { glasses: null, hat: null, clothing: null } as Record<Category, CatalogItem | null>,
  images: { glasses: null, hat: null, clothing: null } as Record<Category, ItemImage | null>,
  /** Rigid placement for face items; clothing uses the garment mesh instead. */
  smoothed: { glasses: null, hat: null } as Record<RigidCategory, HeadFrame | null>,
  /** The face oval on screen, which keeps an item's shadow off the room behind the head. */
  faceOutline: null as Vec[] | null,
  garment: null as ControlPair[] | null,
  /** Live size trim per category, so one catalog suits different builds and camera distances. */
  size: { glasses: 1, hat: 1, clothing: 1 } as Record<Category, number>,
  lostFrames: { face: 0, pose: 0 } as Record<Detector, number>,
  lastVideoTime: -1,
  frameCount: 0,
  rafId: 0,
  cameraLive: false,
  face: null as FaceLandmarker | null,
  pose: null as PoseLandmarker | null,
  gesture: null as GestureRecognizer | null,
  segmenter: null as ImageSegmenter | null,
  mask: null as SegmentMask | null,
  status: '',
  /** Last message the render loop wrote, so it only overwrites its own text. */
  loopStatus: null as string | null,
  mode: 'local' as Mode,
  /** The index-and-thumb cursor, for working the app from a step back. */
  handControl: false,
  decart: null as RealTimeClient | null,
  view: 'tryon' as View,
  background: NO_BACKGROUND,
  /** A backdrop tile under the mouse, shown instead of the chosen one until the pointer leaves. */
  hoverBackground: null as Background | null,
  previewBusy: false,
  booth: {
    running: false,
    cancelled: false,
    /** False after a run until the hand drops, so a ✌️ held through the photos does not restart it. */
    armed: true,
  },
};

const ui = mountUi(document.body, {
  onCategory(category) {
    state.activeTab = category;
    refreshUi();
  },
  onSize(factor) {
    state.size[state.activeTab] = factor;
  },
  onSelect: toggleItem,
  onUpload(file) {
    if (file.type !== 'image/png') {
      setStatus('Upload a PNG with a transparent background.', 'warn');
      return;
    }
    const item = createUploadItem(file, state.activeTab);
    state.items.push(item);
    showView('tryon');
    void wear(item);
  },
  onSnapshot: takeSnapshot,
  onView: showView,
  onCapture() {
    if (state.view === 'photobooth') void startPhotobooth();
    else if (state.view === 'tryon') void takeSnapshot();
    else showView('tryon');
  },
  onMode: switchMode,
  onConnectAi: connectAi,
  onHandControl() {
    state.handControl = !state.handControl;
    ui.setHandControl(state.handControl);
    handCursor.setEnabled(state.handControl);
    if (state.handControl) {
      if (!state.gesture) void loadGestureRecognizer();
      if (state.cameraLive) setStatus('Hand control on. Pinch to click.', 'ok');
      else setStatus('Start the camera to use hand control.', 'warn');
    }
    syncLoop();
  },
  onRetry() {
    void (state.cameraLive ? loadNeededDetectors() : boot());
  },
});

const shareDialog = mountShareDialog();

const booth = mountBoothPanel({
  onStart: () => void startPhotobooth(),
  onCancel: () => (state.booth.cancelled = true),
  onOpenGallery: () => showView('gallery'),
  onShare: (sheet) => void shareDialog.open(sheet, `photobooth-${Date.now()}`),
  onBackground(background) {
    state.background = background;
    state.hoverBackground = null;
    if (background.kind !== 'none') void loadSegmenter();
    schedulePreview();
  },
  onBackgroundHover(background) {
    state.hoverBackground = background;
    if (background && background.kind !== 'none') void loadSegmenter();
  },
  onSettingsChange: schedulePreview,
  onSticker: (sticker) => stickers.add(sticker),
  onClearStickers: () => stickers.clear(),
});

const gallery = mountGalleryView({
  onNewBooth: () => showView('photobooth'),
  onCount: (count) => ui.setGalleryCount(count),
  onShare: (shot) => void shareDialog.open(shot.blob, `${shot.kind}-${shot.createdAt}`),
  pointLabel: (id) => sites?.pointLabel(id) ?? null,
});

const backend = createLocalBackend(browserStore());
/** Set once someone signs in; the camera and the models wait for that. */
let sites: SitesView | null = null;
let dashboard: DashboardView | null = null;

/** The camera is on screen and drawn here: try-on overlays, backdrops and tracking apply. */
function onDevice(): boolean {
  return state.mode === 'local' && CAMERA_VIEWS.includes(state.view);
}

/** The loop runs while the camera is drawn here, or anywhere while the hand drives the cursor. */
function loopShouldRun(): boolean {
  return state.cameraLive && (onDevice() || state.handControl);
}

function syncLoop(): void {
  if (loopShouldRun()) startLoop();
  else cancelAnimationFrame(state.rafId);
}

function showView(view: View): void {
  if (view === state.view) return;
  if (state.booth.running) {
    setStatus('Finish or cancel the photobooth first.', 'warn');
    return;
  }
  state.view = view;
  ui.setView(view);
  stickers.setVisible(view === 'photobooth');
  if (view !== 'photobooth') booth.showPreview(null);
  if (view === 'photobooth') {
    // Load segmentation up front so hovering a backdrop previews it at once.
    void loadSegmenter();
    schedulePreview();
  }
  if (view === 'gallery') void gallery.refresh();
  if (view === 'sites') void sites?.refresh();
  if (view === 'dashboard') void dashboard?.refresh();
  syncLoop();
}

/** The video on screen: Decart's generated stream once it arrives, otherwise the camera. */
function visibleVideo(): HTMLVideoElement {
  return state.mode === 'ai' && !remoteVideo.hidden ? remoteVideo : video;
}

const stageEl = document.querySelector<HTMLElement>('.stage')!;

/** Shapes the stage like the video on screen, so no height goes to letterbox bars. */
function fitStage(): void {
  const source = visibleVideo();
  if (source.videoWidth && source.videoHeight) {
    stageEl.style.aspectRatio = `${source.videoWidth} / ${source.videoHeight}`;
  }
}
for (const element of [video, remoteVideo]) {
  element.addEventListener('loadedmetadata', fitStage);
  element.addEventListener('resize', fitStage);
}

/** What the viewer sees right now, including the garment. */
function currentFrame(): HTMLCanvasElement {
  const source = visibleVideo();
  return captureFrame(source, source === video ? overlay.canvas : null);
}

/** A photobooth shot: the frame plus the stickers placed on it. */
function boothFrame(): HTMLCanvasElement {
  const frame = currentFrame();
  drawStickers(frame, stickers.list());
  return frame;
}

/** The backdrop as a still at camera size, for Decart's reference; null for blur, which has no picture. */
async function scenePicture(background: Background): Promise<Blob | null> {
  if (background.kind === 'blur') return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  drawBackdrop(canvas.getContext('2d')!, background, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'image/jpeg', 0.9);
}

/** Has Decart redraw one shot in the scene, fits the result back to the shot's size, then adds the stickers. */
async function blendShot(
  shot: HTMLCanvasElement,
  placed: readonly PlacedSticker[],
  apiKey: string,
  scene: Promise<Blob | null>,
): Promise<HTMLCanvasElement> {
  const blended = await createImageBitmap(await blendIntoScene(apiKey, await canvasToBlob(shot, 'image/jpeg', 0.92), await scene));
  const out = document.createElement('canvas');
  out.width = shot.width;
  out.height = shot.height;
  const crop = coverCrop(blended.width, blended.height, out.height / out.width);
  out.getContext('2d')!.drawImage(blended, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
  drawStickers(out, placed);
  return out;
}

function shownBackground(): Background {
  return state.hoverBackground ?? state.background;
}

/** The backdrop only applies in the photobooth, and needs the on-device segmenter. */
function backgroundActive(): boolean {
  return state.view === 'photobooth' && shownBackground().kind !== 'none';
}

/** Redraws the sheet preview from the live camera: what Start would print right now. */
async function refreshPreview(): Promise<void> {
  if (state.view !== 'photobooth' || state.booth.running || state.previewBusy) return;
  if (!state.cameraLive || visibleVideo().videoWidth === 0) {
    booth.showPreview(null);
    return;
  }
  state.previewBusy = true;
  try {
    const settings = booth.settings();
    const shot = boothFrame();
    const shots = Array.from({ length: shotsFor(settings.layout) }, () => shot);
    const sheet = await composeBooth(shots, settings.layout, settings.frame, settings.caption, new Date());
    if (state.view === 'photobooth' && !state.booth.running) booth.showPreview(sheet);
  } finally {
    state.previewBusy = false;
  }
}

let previewTimer = 0;
/** Redraws shortly after a setting changes, so typing a caption does not queue a redraw per key. */
function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void refreshPreview(), 120);
}

async function startPhotobooth(): Promise<void> {
  if (state.booth.running) return;
  if (!state.cameraLive) {
    setStatus('Start the camera first.', 'warn');
    return;
  }
  const settings = booth.settings();
  const blend = settings.blend === 'ai';
  if (blend && state.background.kind === 'none') {
    setStatus('Pick a backdrop for the AI blend.', 'warn');
    return;
  }
  if (blend && !settings.apiKey) {
    setStatus('Paste your Decart API key for the AI blend.', 'warn');
    return;
  }
  const total = shotsFor(settings.layout);
  // Each blend starts as soon as its shot is taken, so Decart works through the next countdown.
  const scene = blend ? scenePicture(state.background) : Promise.resolve(null);
  const blends: Promise<HTMLCanvasElement>[] = [];
  state.booth.running = true;
  state.booth.cancelled = false;
  booth.setRunning(true);
  booth.progress(0, total);
  setStatus('Photobooth running. Strike a pose.', 'info');

  try {
    const shots = await runBoothSession(total, settings.seconds, {
      // The blend adds the stickers after Decart, so the model never redraws them.
      capture: blend ? currentFrame : boothFrame,
      countdown: (seconds) => booth.countdown(seconds),
      flash: () => booth.flash(),
      shot: (index, _total, frame) => {
        booth.progress(index + 1, total);
        if (!blend) return;
        const pending = blendShot(frame, [...stickers.list()], settings.apiKey, scene);
        // Handled by Promise.all below; this stops a failure during the run, or after a cancel, going unhandled.
        pending.catch(() => {});
        blends.push(pending);
      },
      cancelled: () => state.booth.cancelled,
    });
    if (!shots) {
      setStatus('Photobooth cancelled.', 'info');
      return;
    }
    if (blend) {
      booth.working('Blending with AI…');
      setStatus(`Decart is blending ${total} ${total === 1 ? 'shot' : 'shots'} into the scene…`, 'info');
    }
    const final = blend ? await Promise.all(blends) : shots;
    const sheet = await composeBooth(final, settings.layout, settings.frame, settings.caption, new Date());
    const blob = await canvasToBlob(sheet);
    await saveShot(blob, 'photobooth', devicePoint(), settings.layout);
    booth.setResult(blob);
    await gallery.refresh();
    setStatus('Sheet saved to the gallery.', 'ok');
  } catch (e) {
    console.error(e);
    // The Decart SDK rejects with plain { code, message } objects rather than Errors.
    const reason = (e as { message?: string } | null)?.message ?? String(e);
    setStatus(blend ? `AI blend failed: ${reason}` : 'Photobooth failed.', 'error');
  } finally {
    state.booth.running = false;
    state.booth.armed = false;
    booth.setRunning(false);
    booth.hideHud();
  }
}

/** Swaps between the on-device overlay and the generated stream coming back from Decart. */
function switchMode(mode: Mode): void {
  if (state.mode === mode) return;
  state.mode = mode;
  ui.setMode(mode);

  if (mode === 'local') {
    state.decart?.disconnect();
    state.decart = null;
    remoteVideo.hidden = true;
    remoteVideo.srcObject = null;
    video.hidden = false;
    overlay.canvas.hidden = false;
    syncLoop();
    setStatus('Ready', 'ok');
    return;
  }

  overlay.clear();
  syncLoop();
  setStatus('Paste your Decart API key, then press Connect.');
}

async function connectAi(apiKey: string): Promise<void> {
  if (!apiKey) {
    setStatus('A Decart API key is needed for this mode.', 'warn');
    return;
  }
  const stream = video.srcObject as MediaStream | null;
  if (!stream) {
    setStatus('Start the camera first.', 'warn');
    return;
  }

  storeKey(apiKey);
  setStatus('Connecting to Decart…');
  try {
    state.decart = await connectDecart(apiKey, stream, {
      onRemoteStream(remote) {
        remoteVideo.srcObject = remote;
        remoteVideo.hidden = false;
        video.hidden = true;
        overlay.canvas.hidden = true;
        setStatus('Streaming to Decart. Billed per second.', 'ok');
      },
      onClosed: (reason) => setStatus(`Decart: ${reason}`, 'warn', true),
      onError: (message) => setStatus(`Decart: ${message}`, 'error'),
    });
    const worn = state.worn.clothing;
    if (worn) await wearGarment(state.decart, worn);
  } catch (e) {
    console.error(e);
    setStatus(e instanceof Error ? `Decart: ${e.message}` : 'Could not reach Decart.', 'error', true);
  }
}

function setStatus(text: string, kind: StatusKind = 'info', retry = false): void {
  if (state.status === text) return;
  state.status = text;
  ui.setStatus(text, kind, retry);
}

function wornCategories(): Category[] {
  return DRAW_ORDER.filter((category) => state.worn[category] !== null);
}

function neededDetectors(): Set<Detector> {
  return new Set(wornCategories().map((category) => DETECTOR_OF[category]));
}

function refreshUi(): void {
  ui.setTabs(state.activeTab, wornCategories());
  ui.setSize(state.size[state.activeTab]);
  ui.renderStrip(
    state.items.filter((item) => item.category === state.activeTab),
    state.worn[state.activeTab]?.id ?? null,
  );
}

function forget(category: Category): void {
  if (category === 'clothing') {
    state.garment = null;
    garmentFilter.reset();
  } else {
    state.smoothed[category] = null;
    frameFilters[category].reset();
  }
}

function takeOff(category: Category): void {
  state.worn[category] = null;
  state.images[category] = null;
  forget(category);
  refreshUi();
}

async function wear(item: CatalogItem): Promise<void> {
  const { category } = item;
  state.worn[category] = item;
  state.images[category] = null;
  forget(category);
  refreshUi();
  try {
    const image = await loadImage(item.src);
    if (state.worn[category] === item) state.images[category] = image;
  } catch {
    setStatus(`Could not read ${item.name}.`, 'error');
    takeOff(category);
    return;
  }
  if (state.cameraLive) await loadNeededDetectors();
}

function toggleItem(item: CatalogItem): void {
  if (state.mode === 'ai') {
    if (item.category !== 'clothing') {
      setStatus('Decart AI changes clothing only.', 'warn');
      return;
    }
    state.worn.clothing = item;
    refreshUi();
    if (state.decart) {
      wearGarment(state.decart, item).catch((e) => setStatus(`Decart: ${e.message}`, 'error'));
    }
    return;
  }
  if (state.worn[item.category]?.id === item.id) takeOff(item.category);
  else void wear(item);
}

async function loadNeededDetectors(): Promise<boolean> {
  const missing = [...neededDetectors()].filter((detector) => state[detector] === null);
  if (missing.length === 0) {
    setStatus('Ready', 'ok');
    return true;
  }
  setStatus('Loading model…');
  try {
    for (const detector of missing) {
      if (detector === 'face') state.face = await getFaceLandmarker();
      else state.pose = await getPoseLandmarker();
    }
    if (neededDetectors().has('pose')) void loadSegmenter();
    setStatus('Ready', 'ok');
    return true;
  } catch (e) {
    console.error(e);
    setStatus('Could not load the tracking model. Check your connection.', 'error', true);
    return false;
  }
}

/** Segmentation only sharpens the result, so a failure leaves the garment drawn without occlusion. */
async function loadSegmenter(): Promise<void> {
  if (state.segmenter) return;
  try {
    state.segmenter = await getSegmenter();
  } catch (e) {
    console.warn('Segmentation unavailable, drawing the garment without occlusion', e);
  }
}

async function loadGestureRecognizer(): Promise<void> {
  try {
    state.gesture = await getGestureRecognizer();
  } catch (e) {
    console.error(e);
    setStatus('Gesture capture unavailable. Use the Snapshot button.', 'warn');
  }
}

function devicePoint(): string | null {
  return sites?.devicePointId() ?? null;
}

async function takeSnapshot(): Promise<void> {
  if (!state.cameraLive) {
    setStatus('Start the camera first.', 'warn');
    return;
  }
  try {
    await saveShot(await canvasToBlob(currentFrame()), 'snapshot', devicePoint());
    await gallery.refresh();
    setStatus('Snapshot saved to the gallery.', 'ok');
  } catch (e) {
    setStatus('Snapshot failed.', 'error');
    console.error(e);
  }
}

function detectAll(needed: Set<Detector>, timestamp: number): Record<Detector, NormalizedLandmark[] | null> {
  return {
    face: needed.has('face') && state.face ? detectFace(state.face, video, timestamp) : null,
    pose: needed.has('pose') && state.pose ? detectPose(state.pose, video, timestamp) : null,
  };
}

function drawRigid(category: RigidCategory, lm: NormalizedLandmark[] | null, width: number, height: number): void {
  const item = state.worn[category];
  const image = state.images[category];
  if (!item || !image) return;

  if (lm) {
    const raw = packFrame(FRAME_OF[category](lm, width, height));
    state.smoothed[category] = unpackFrame(frameFilters[category].filter(raw, performance.now() / 1000));
  } else if (state.lostFrames.face > LOST_FRAME_GRACE) {
    forget(category);
  }

  const frame = state.smoothed[category];
  if (!frame) return;
  overlay.draw({
    frame,
    image: image.source,
    rect: itemRect(frame, placementOf(item, state.size[category]), image),
    shadow: SHADOW_OF[category],
    face: state.faceOutline,
    video,
  });
}

/** Warps the garment onto the pose skeleton so it follows the torso and the arms. */
function drawClothing(lm: NormalizedLandmark[] | null, width: number, height: number): void {
  const item = state.worn.clothing;
  const image = state.images.clothing;
  if (!item || !image) return;

  const body = lm ? readBody(lm, width, height) : null;
  if (body) {
    const shape = image.shape ?? NOMINAL_SHAPE;
    const next = garmentControls(shape, body, item.scale * state.size.clothing, image);
    const eased = garmentFilter.filter(next.flatMap((c) => [c.to.x, c.to.y]), performance.now() / 1000);
    state.garment = next.map((c, i) => ({ from: c.from, to: { x: eased[i * 2], y: eased[i * 2 + 1] } }));
  } else if (state.lostFrames.pose > LOST_FRAME_GRACE) {
    forget('clothing');
  }

  if (!state.garment) return;
  const layer = garmentLayer.render({
    image: image.source,
    deform: mlsSimilarity(state.garment),
    columns: MESH_COLUMNS,
    rows: MESH_ROWS,
    video,
    width,
    height,
    mask: state.mask,
    neck: state.garment[CONTROL.NECK].to,
    torso: torsoQuad(state.garment),
  });
  overlay.ctx.drawImage(layer, 0, 0);
}

function trackingStatus(needed: Set<Detector>): { text: string; kind: StatusKind } | null {
  if (needed.has('face') && state.lostFrames.face > LOST_FRAME_GRACE) {
    return { text: 'No face detected.', kind: 'warn' };
  }
  if (needed.has('pose') && state.lostFrames.pose > LOST_FRAME_GRACE) {
    return { text: 'Step back so both shoulders are in view.', kind: 'warn' };
  }
  return null;
}

/** Shows a loop message, or restores "Ready" once the loop has nothing to say and nobody else wrote since. */
function setLoopStatus(next: { text: string; kind: StatusKind } | null): void {
  if (next) {
    setStatus(next.text, next.kind);
    state.loopStatus = next.text;
  } else if (state.loopStatus !== null) {
    if (state.status === state.loopStatus) setStatus('Ready', 'ok');
    state.loopStatus = null;
  }
}

/** ✌️ handling: a snapshot countdown on Try on, an immediate run on Photobooth. */
function gestureCapture(gesture: string | null): TriggerState {
  const idle: TriggerState = { secondsLeft: null, capture: false };
  if (state.booth.running) return idle;
  if (state.view === 'photobooth') {
    if (gesture === null) state.booth.armed = true;
    if (state.booth.armed && boothTrigger.update(gesture, performance.now()).capture) void startPhotobooth();
    return idle;
  }
  return state.view === 'tryon' ? snapTrigger.update(gesture, performance.now()) : idle;
}

function frame(): void {
  state.rafId = requestAnimationFrame(frame);
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;

  const width = video.videoWidth;
  const height = video.videoHeight;
  const timestamp = nextTimestamp();

  // One hand reading per frame feeds both the cursor and the capture gesture.
  const reading = state.gesture ? readHand(state.gesture, video, timestamp) : NO_HAND;
  if (state.handControl) handCursor.update(reading.hand, width / height, performance.now());
  const capture = gestureCapture(reading.gesture);

  if (!onDevice()) {
    if (capture.capture) {
      state.loopStatus = null;
      void takeSnapshot();
    } else {
      setLoopStatus(capture.secondsLeft === null ? null : { text: `Capturing in ${capture.secondsLeft}…`, kind: 'info' });
    }
    return;
  }

  overlay.resize(width, height);
  const needed = neededDetectors();
  const landmarks = detectAll(needed, timestamp);
  for (const detector of ['face', 'pose'] as const) {
    state.lostFrames[detector] = landmarks[detector] ? 0 : state.lostFrames[detector] + 1;
  }
  if (landmarks.face) state.faceOutline = faceOutline(landmarks.face, width, height);
  else if (state.lostFrames.face > LOST_FRAME_GRACE) state.faceOutline = null;

  state.frameCount += 1;
  if (!(needed.has('pose') || backgroundActive()) || !state.segmenter) state.mask = null;
  else if (state.frameCount % SEGMENT_EVERY === 0) {
    state.mask = segmentForVideo(state.segmenter, video, timestamp);
  }

  overlay.clear();
  if (backgroundActive()) {
    const backdrop = backgroundLayer.render(shownBackground(), video, state.mask, width, height);
    if (backdrop) overlay.ctx.drawImage(backdrop, 0, 0);
  }
  for (const category of wornCategories()) {
    if (category === 'clothing') drawClothing(landmarks.pose, width, height);
    else drawRigid(category, landmarks.face, width, height);
  }

  if (DEBUG) {
    for (const lm of Object.values(landmarks)) {
      if (lm) drawLandmarkDots(overlay.ctx, lm, width, height);
    }
  }

  if (capture.capture) {
    state.loopStatus = null;
    void takeSnapshot();
    return;
  }
  if (capture.secondsLeft !== null) {
    overlay.drawCountdown(capture.secondsLeft);
    setLoopStatus({ text: `Capturing in ${capture.secondsLeft}…`, kind: 'info' });
    return;
  }
  setLoopStatus(trackingStatus(needed));
}

function startLoop(): void {
  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelAnimationFrame(state.rafId);
  else if (loopShouldRun()) startLoop();
});

async function loadStoreItems(): Promise<void> {
  try {
    const storeItems = await loadStoreCatalog();
    state.items.unshift(...storeItems);
    refreshUi();
  } catch (e) {
    console.warn('Store catalog unavailable, showing bundled samples only', e);
  }
}

async function boot(): Promise<void> {
  ui.setSnapshotEnabled(false);
  setStatus('Starting camera…');
  try {
    await startCamera(video);
  } catch (e) {
    setStatus(CAMERA_MESSAGES[classifyCameraError(e)], 'error', true);
    console.error(e);
    return;
  }
  state.cameraLive = true;
  state.lastVideoTime = -1;
  ui.setSnapshotEnabled(true);
  void loadGestureRecognizer();
  if ((await loadNeededDetectors()) && loopShouldRun()) startLoop();
}

refreshUi();
ui.setMode('local');
ui.setView('tryon');
stickers.setVisible(false);
/** The preview follows the live camera, backdrop and stickers, so it refreshes on a slow beat too. */
setInterval(() => void refreshPreview(), 1000);
ui.setAiKey(readStoredKey());
void loadStoreItems();

async function start(): Promise<void> {
  const account = await signedIn(backend);
  document.querySelector<HTMLElement>('.shell')!.hidden = false;
  mountAccountButton(backend, account);
  sites = mountSitesView(backend, account, {
    captureCounts: countByPoint,
    onOpenSites: () => showView('sites'),
    onDevicePoint: () => {
      if (state.view === 'dashboard') void dashboard?.refresh();
    },
  });
  await sites.refresh();
  dashboard = mountDashboard(backend, account, {
    devicePointId: () => sites!.devicePointId(),
    pointLabel: (id) => sites!.pointLabel(id),
    onNavigate: showView,
    onPickPoint: () => sites!.pickDevicePoint(),
  });
  // A kiosk linked to a point opens on the camera; a manager's device opens on the dashboard.
  if (!sites.devicePointId()) showView('dashboard');
  void gallery.refresh();
  await wear(DEFAULT_ITEMS[0]);
  await boot();
}

void start();
