import { describe, expect, it } from 'vitest';
import { sizePosition } from '../src/draw/tools';

/**
 * Position sizing has to follow how each segment actually trades: cash in
 * shares, derivatives in indivisible lots, and never above the exchange's cap
 * on a single order.
 */
describe('sizePosition', () => {
  const budget = { accountSize: 100_000, risk: 1 }; // ₹1,000 of risk

  describe('ratio', () => {
    it('is reward over risk, measured from the entry', () => {
      const s = sizePosition(100, 130, 90, budget);
      expect(s.riskPoints).toBe(10);
      expect(s.rewardPoints).toBe(30);
      expect(s.rr).toBe(3);
    });

    it('works the same for a short, where the target sits below the entry', () => {
      const s = sizePosition(100, 70, 110, budget);
      expect(s.riskPoints).toBe(10);
      expect(s.rewardPoints).toBe(30);
      expect(s.rr).toBe(3);
    });

    it('is zero rather than infinite when the stop sits on the entry', () => {
      const s = sizePosition(100, 130, 100, budget);
      expect(s.rr).toBe(0);
      expect(s.qty).toBe(0);
    });
  });

  describe('cash equity', () => {
    it('sizes in whole shares', () => {
      // ₹1,000 budget ÷ ₹10 stop = 100 shares.
      const s = sizePosition(500, 530, 490, budget);
      expect(s.lotSize).toBe(1);
      expect(s.qty).toBe(100);
      expect(s.riskAmount).toBe(1000);
      expect(s.rewardAmount).toBe(3000);
    });

    it('rounds down rather than over-risking', () => {
      // ₹1,000 ÷ ₹30 = 33.3 → 33 shares, ₹990 at risk.
      const s = sizePosition(500, 560, 470, budget);
      expect(s.qty).toBe(33);
      expect(s.riskAmount).toBe(990);
    });
  });

  describe('lot-based derivatives', () => {
    it('buys whole lots and reports the resulting quantity', () => {
      // NIFTY: lot 65, 10-point stop → ₹650 a lot, so one lot fits in ₹1,000.
      const s = sizePosition(23_800, 23_840, 23_790, { ...budget, lotSize: 65 });
      expect(s.lots).toBe(1);
      expect(s.qty).toBe(65);
      expect(s.riskAmount).toBe(650);
    });

    it('returns zero when the budget cannot afford a single lot', () => {
      // The case in the original report: a 42-point stop on NIFTY costs ₹2,730
      // a lot, which ₹1,000 cannot buy. The old maths said "qty 24" — a size
      // no exchange would accept.
      const s = sizePosition(23_706, 23_880, 23_664, { ...budget, lotSize: 65 });
      expect(s.lots).toBe(0);
      expect(s.qty).toBe(0);
      expect(s.riskAmount).toBe(0);
      // The ratio is still worth showing even when the size is not affordable.
      expect(s.rr).toBeCloseTo(4.14, 2);
    });

    it('scales with a bigger account', () => {
      // ₹10,000 of risk ÷ ₹2,730 a lot = 3 lots.
      const s = sizePosition(23_706, 23_880, 23_664, {
        accountSize: 1_000_000,
        risk: 1,
        lotSize: 65,
      });
      expect(s.lots).toBe(3);
      expect(s.qty).toBe(195);
    });

    it('handles a commodity lot the same way', () => {
      // CRUDEOILM: lot 10, ₹20 stop → ₹200 a lot; ₹1,000 buys 5.
      const s = sizePosition(6_000, 6_100, 5_980, { ...budget, lotSize: 10 });
      expect(s.lots).toBe(5);
      expect(s.qty).toBe(50);
    });
  });

  describe('exchange order cap', () => {
    it('clamps to the freeze limit, rounded down to a whole lot', () => {
      // 30 lots affordable, but the exchange freezes a single order at 1,800
      // (27 lots of 65 = 1,755; 28 would be 1,820 and rejected).
      const s = sizePosition(23_800, 23_900, 23_790, {
        accountSize: 20_000_000,
        risk: 1,
        lotSize: 65,
        maxQty: 1_800,
      });
      expect(s.capped).toBe(true);
      expect(s.lots).toBe(27);
      expect(s.qty).toBe(1_755);
    });

    it('leaves a size under the cap alone', () => {
      const s = sizePosition(23_800, 23_840, 23_790, {
        ...budget,
        lotSize: 65,
        maxQty: 1_800,
      });
      expect(s.capped).toBe(false);
      expect(s.qty).toBe(65);
    });
  });

  describe('degenerate input', () => {
    it('yields nothing without an account or a risk percentage', () => {
      expect(sizePosition(100, 130, 90, {}).qty).toBe(0);
      expect(sizePosition(100, 130, 90, { accountSize: 100_000, risk: 0 }).qty).toBe(0);
    });

    it('treats a fractional or absent lot size as one unit', () => {
      expect(sizePosition(100, 130, 90, { ...budget, lotSize: 0 }).lotSize).toBe(1);
      expect(sizePosition(100, 130, 90, { ...budget, lotSize: 1.7 }).lotSize).toBe(1);
    });
  });
});
