// The booth business: every record the booth client, the cashier, the queue and the cloud
// dashboard share. Branches are the account's locations and booths are its points.

/** Whole rupiah. Every amount in the app is an integer, so totals never drift. */
export type Rupiah = number;

// ---------- catalogue ----------

export type SessionMode = 'strip' | 'gif' | 'video' | 'live' | 'vintage';

export const SESSION_MODES: Record<SessionMode, { label: string; detail: string }> = {
  strip: { label: 'Photo strip', detail: 'Timed shots printed on a sheet' },
  gif: { label: 'GIF', detail: 'A looping burst of frames' },
  video: { label: 'Video booth', detail: 'An 8 second clip' },
  live: { label: 'Live photo', detail: 'A still with a 3 second clip' },
  vintage: { label: 'Original / vintage', detail: 'Warm film tone, printed' },
};

/** A kind of booth (photobox, studio, 360), each with its own price per mode. */
export interface BoothCategory {
  id: string;
  name: string;
  prices: Partial<Record<SessionMode, Rupiah>>;
}

export type PaperSize = '2R' | '3R' | '4R' | '5R' | '6R' | '8R' | 'A4' | 'A3' | 'panoramic' | 'custom';

export interface PrintPrice {
  size: PaperSize;
  price: Rupiah;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  price: Rupiah;
  stock: number;
}

export interface DiscountPreset {
  id: string;
  name: string;
  kind: 'percent' | 'amount';
  value: number;
}

/** Per-booth settings that the account's point record does not carry. */
export interface BoothProfile {
  pointId: string;
  categoryId: string;
  /** IANA zone, so vouchers and reports follow the booth's own clock overseas. */
  timeZone: string;
  modes: SessionMode[];
}

// ---------- vouchers ----------

export interface HappyHour {
  /** 0 = Sunday, as Date.getDay. */
  days: number[];
  /** "HH:MM" in the booth's time zone. */
  start: string;
  end: string;
}

export interface Voucher {
  id: string;
  code: string;
  kind: 'percent' | 'amount' | 'free';
  value: number;
  /** single: one session anywhere it applies. multi: reusable up to maxUses across booths. */
  scope: 'single' | 'multi';
  /** Empty means every booth. */
  boothIds: string[];
  maxUses: number;
  uses: number;
  /** "YYYY-MM-DD" in the booth's time zone, inclusive. Empty means open-ended. */
  validFrom: string;
  validTo: string;
  happyHour: HappyHour | null;
  /** Frames only this voucher unlocks. */
  frameIds: string[];
  /** Free event mode: every session at the booths is free while the voucher is valid. */
  eventMode: boolean;
  active: boolean;
  /** Set for codes printed on a cashier receipt for one paid session. */
  orderId?: string;
  createdAt: number;
}

// ---------- orders and money ----------

export type LineKind = 'session' | 'print' | 'merch' | 'reprint';

export interface OrderLine {
  id: string;
  kind: LineKind;
  label: string;
  /** Category id for sessions, size for prints, product id for merch, shot id for reprints. */
  refId: string;
  mode?: SessionMode;
  size?: PaperSize;
  unitPrice: Rupiah;
  qty: number;
  /** Discount spread onto this line from presets and vouchers. */
  discount: Rupiah;
  refunded: boolean;
}

export type PaymentMethod = 'cash' | 'qris' | 'card' | 'ewallet';

export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'qris', 'card', 'ewallet'];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  qris: 'QRIS',
  card: 'Card',
  ewallet: 'E-wallet',
};

export type PaymentStatus = 'pending' | 'paid' | 'expired' | 'failed' | 'cancelled';

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Waiting',
  paid: 'Paid',
  expired: 'Expired',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export interface Payment {
  id: string;
  method: PaymentMethod;
  amount: Rupiah;
  status: PaymentStatus;
  /** Gateway order id, EDC approval code or e-wallet reference. */
  reference: string;
  gateway?: string;
  qrString?: string;
  /** When a pending QR stops being valid. */
  expiresAt?: number;
  tendered?: Rupiah;
  /** The e-wallet brand, or the EDC terminal, the payment went through. */
  wallet?: string;
  terminalId?: string;
  /** The processing fee (MDR) at the rate set when the payment was made. */
  fee?: Rupiah;
  /** Why it was cancelled, or who confirmed it by hand. */
  note?: string;
  createdAt: number;
  paidAt?: number;
}

export interface PaymentMethodRule {
  enabled: boolean;
  /** Where the method is offered. */
  cashier: boolean;
  booth: boolean;
  /** Processing fee as a percentage, such as 0.7 for QRIS MDR. */
  feePercent: number;
}

export interface GatewaySettings {
  provider: 'midtrans' | 'xendit' | 'doku';
  mode: 'sandbox' | 'production';
  merchantId: string;
  /** The browser-safe client key. The server key never belongs in the app. */
  clientKey: string;
  qrExpiryMinutes: number;
}

export interface Terminal {
  id: string;
  name: string;
  branchId: string;
  provider: string;
}

export interface PaymentSettings {
  gateway: GatewaySettings;
  methods: Record<PaymentMethod, PaymentMethodRule>;
  /** E-wallet brands the till can record, such as GoPay or OVO. */
  wallets: string[];
  terminals: Terminal[];
}

export type Channel = 'cashier' | 'booth';

export interface Order {
  id: string;
  number: string;
  channel: Channel;
  branchId: string;
  boothId: string | null;
  staffId: string | null;
  shiftId: string | null;
  lines: OrderLine[];
  presetId: string | null;
  voucherCode: string | null;
  subtotal: Rupiah;
  discount: Rupiah;
  total: Rupiah;
  payments: Payment[];
  status: 'open' | 'paid' | 'void';
  /** Codes printed on the receipt, one per session line, that unlock the session at a booth. */
  sessionVouchers: string[];
  ticketNumbers: string[];
  customerEmail: string;
  createdAt: number;
  paidAt?: number;
}

export interface Refund {
  id: string;
  orderId: string;
  lineId: string;
  amount: Rupiah;
  reason: string;
  staffId: string | null;
  supervisorId: string;
  method: PaymentMethod;
  at: number;
}

export interface Shift {
  id: string;
  branchId: string;
  staffId: string | null;
  openedAt: number;
  openingCash: Rupiah;
  closedAt?: number;
  countedCash?: Rupiah;
}

// ---------- booth sessions and delivery ----------

export interface Effects {
  filter: 'none' | 'mono' | 'warm' | 'cool' | 'vintage' | 'vivid';
  mirror: boolean;
  zoom: number;
  brightness: number;
  contrast: number;
  saturation: number;
}

export const NO_EFFECTS: Effects = { filter: 'none', mirror: true, zoom: 1, brightness: 100, contrast: 100, saturation: 100 };

export interface BoothSession {
  id: string;
  boothId: string;
  branchId: string;
  mode: SessionMode;
  orderId: string | null;
  voucherCode: string | null;
  frameId: string | null;
  eventId: string | null;
  price: Rupiah;
  startedAt: number;
  endedAt?: number;
  /** Gallery shot ids: photos, GIF, clips and the BTS recording. */
  shotIds: string[];
  prints: number;
  /** Opens the customer's soft-file page. */
  token: string;
  consent: boolean;
  email: string;
  purgedAt?: number;
}

export interface GalleryEvent {
  id: string;
  name: string;
  boothIds: string[];
  from: string;
  to: string;
}

// ---------- queue ----------

export type TicketStatus = 'waiting' | 'called' | 'done' | 'skipped';

export interface Ticket {
  id: string;
  number: string;
  token: string;
  /** Booths this customer is waiting for; the first one free calls them. */
  boothIds: string[];
  status: TicketStatus;
  /** Sort key; lower is served first. */
  position: number;
  checkedIn: boolean;
  calledBoothId: string | null;
  calledAt?: number;
  recalls: number;
  name: string;
  phone: string;
  email: string;
  orderId: string | null;
  createdAt: number;
}

// ---------- printing and devices ----------

export interface Printer {
  id: string;
  name: string;
  /** DNP reports paper left through its SDK; other brands count down from a manual count. */
  brand: 'dnp' | 'other';
  boothIds: string[];
  sizes: PaperSize[];
  paperLeft: number;
  lowThreshold: number;
  status: 'ok' | 'error' | 'offline';
  error: string;
}

export interface CameraSettings {
  iso: number;
  aperture: number;
  shutter: string;
  whiteBalance: 'auto' | 'daylight' | 'cloudy' | 'tungsten' | 'fluorescent' | 'flash';
  exposureComp: number;
  pictureStyle: 'standard' | 'portrait' | 'landscape' | 'neutral' | 'faithful' | 'monochrome';
}

export interface CameraProfile {
  boothId: string;
  driver: 'webcam' | 'edsdk';
  preview: CameraSettings;
  capture: CameraSettings;
  secondaryDeviceId: string;
}

export interface BoothHealth {
  boothId: string;
  lastHeartbeat: number;
  version: string;
  cameraConnected: boolean;
  cameraBattery: number | null;
  online: boolean;
}

export type AlertKind = 'low-paper' | 'printer-error' | 'camera-disconnected' | 'camera-battery' | 'booth-offline';

export const ALERT_LABELS: Record<AlertKind, string> = {
  'low-paper': 'Low paper',
  'printer-error': 'Printer error',
  'camera-disconnected': 'Camera disconnected',
  'camera-battery': 'Camera battery low',
  'booth-offline': 'Booth offline',
};

export interface Alert {
  id: string;
  kind: AlertKind;
  /** What the alert is about, so the same problem is never raised twice while open. */
  subject: string;
  branchId: string | null;
  boothId: string | null;
  message: string;
  openedAt: number;
  resolvedAt?: number;
}

export type NotifyChannel = 'popup' | 'email' | 'whatsapp';

export interface RoutingRule {
  id: string;
  /** null = every branch. */
  branchId: string | null;
  kinds: AlertKind[];
  channels: NotifyChannel[];
  /** 'owner', 'on-duty' or a staff id. */
  recipients: string[];
}

export interface Notification {
  id: string;
  channel: 'email' | 'whatsapp';
  to: string;
  subject: string;
  body: string;
  at: number;
}

// ---------- people ----------

export type Role = 'owner' | 'admin' | 'supervisor' | 'cashier' | 'operator';

export interface Staff {
  id: string;
  name: string;
  role: Role;
  /** Branches this person sees. Empty means all. */
  branchIds: string[];
  pinHash: string;
  pinSalt: string;
  email: string;
  phone: string;
  onDuty: boolean;
  active: boolean;
}

// ---------- content ----------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Frame {
  id: string;
  name: string;
  category: string;
  size: PaperSize;
  /** PNG with transparent holes where the photos go. */
  image: string;
  width: number;
  height: number;
  slots: Rect[];
  active: boolean;
}

export interface Branding {
  brandName: string;
  logo: string;
  accent: string;
  ink: string;
  background: string;
  welcome: string;
  thanks: string;
  instagram: string;
  tiktok: string;
  website: string;
  customDomain: string;
}

/** A face cropped from the camera for AI presets, kept until the retention window ends. */
export interface FaceRecord {
  id: string;
  /** Blob id of the JPEG crop. */
  image: string;
  boothId: string | null;
  createdAt: number;
}

export type PresetLayout = 'cover' | 'polaroid' | 'poster' | 'pass' | 'squad' | 'frame';

/** A template the captured faces fill: drawn on the device, and redrawn by AI from its prompt. */
export interface Preset {
  id: string;
  name: string;
  layout: PresetLayout;
  /** What the AI makes of the filled template, in 20 to 30 words. */
  prompt: string;
  /** For the frame layout: the uploaded frame whose windows hold the faces. */
  frameId: string | null;
  active: boolean;
  builtIn: boolean;
}

export interface AdItem {
  id: string;
  name: string;
  kind: 'image' | 'video';
  src: string;
  seconds: number;
  active: boolean;
}

// ---------- fleet ----------

export interface Release {
  id: string;
  version: string;
  notes: string;
  /** Share of booths, 0 to 100, that take this release. */
  percent: number;
  status: 'staged' | 'rolled-back';
  createdAt: number;
}

export interface SupportSession {
  id: string;
  boothId: string;
  code: string;
  requestedBy: string;
  status: 'waiting' | 'connected' | 'ended';
  startedAt: number;
  endedAt?: number;
  log: string[];
}

export interface ActivityEntry {
  id: string;
  at: number;
  staffId: string | null;
  branchId: string | null;
  kind: string;
  message: string;
  amount?: Rupiah;
}

export interface Settings {
  shiftsEnabled: boolean;
  retentionDays: number;
  payments: PaymentSettings;
  idleSeconds: number;
  adsEnabled: boolean;
  receiptFooter: string;
  queuePrefix: string;
  /** Which faces the booth's face page lists: every face kept, or only this customer's. */
  faceLibrary: 'all' | 'visit';
}

/** Everything the business keeps, stored per workspace. */
export interface OpsState {
  version: 1;
  categories: BoothCategory[];
  printPrices: PrintPrice[];
  products: Product[];
  presets: DiscountPreset[];
  booths: BoothProfile[];
  vouchers: Voucher[];
  orders: Order[];
  refunds: Refund[];
  shifts: Shift[];
  sessions: BoothSession[];
  events: GalleryEvent[];
  tickets: Ticket[];
  printers: Printer[];
  cameras: CameraProfile[];
  health: BoothHealth[];
  alerts: Alert[];
  rules: RoutingRule[];
  notifications: Notification[];
  staff: Staff[];
  frames: Frame[];
  faces: FaceRecord[];
  aiPresets: Preset[];
  branding: Branding;
  ads: AdItem[];
  releases: Release[];
  support: SupportSession[];
  activity: ActivityEntry[];
  settings: Settings;
  counters: { order: number; ticket: number };
}
