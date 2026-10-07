import { certExpiryMilestone } from '../aeat-cert-expiry.service';

describe('certExpiryMilestone', () => {
  it('avisa a 30, 15 y 7 días y al caducar', () => {
    expect(certExpiryMilestone(45)).toBeNull();
    expect(certExpiryMilestone(30)).toBe(30);
    expect(certExpiryMilestone(16)).toBe(30);
    expect(certExpiryMilestone(15)).toBe(15);
    expect(certExpiryMilestone(8)).toBe(15);
    expect(certExpiryMilestone(7)).toBe(7);
    expect(certExpiryMilestone(1)).toBe(7);
    expect(certExpiryMilestone(0)).toBe(0);
    expect(certExpiryMilestone(-3)).toBe(0);
  });
});
