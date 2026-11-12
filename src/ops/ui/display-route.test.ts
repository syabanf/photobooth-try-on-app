import { describe, expect, it } from 'vitest';
import { displayRoute } from './display-route';

describe('displayRoute', () => {
  it('reads each screen from the hash', () => {
    expect(displayRoute('#display=queue')).toEqual({ kind: 'queue' });
    expect(displayRoute('#display=customer&lock=1')).toEqual({ kind: 'customer' });
    expect(displayRoute('#display=kiosk&booth=b1')).toEqual({ kind: 'kiosk', boothId: 'b1' });
    expect(displayRoute('#display=kiosk')).toEqual({ kind: 'kiosk', boothId: null });
    expect(displayRoute('#g=abc')).toEqual({ kind: 'gallery', id: 'abc' });
    expect(displayRoute('#checkin=t1')).toEqual({ kind: 'checkin', id: 't1' });
  });

  it('leaves the staff app to everything else', () => {
    expect(displayRoute('')).toBeNull();
    expect(displayRoute('#invite=ABCD-EFGH')).toBeNull();
    expect(displayRoute('#display=unknown')).toBeNull();
  });
});
