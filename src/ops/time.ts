// Wall-clock time in a booth's own time zone, so an overseas booth applies its local happy hour.

export interface ZonedTime {
  /** "YYYY-MM-DD" */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function zonedTime(time: number, timeZone: string): ZonedTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(time).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

/** "14:30" → 870. */
export function clockMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + (minutes || 0);
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The browser's own zone, the default for a new booth. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';
}

export const WEEKDAY_NAMES = WEEKDAYS;
