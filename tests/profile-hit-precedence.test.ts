/**
 * A profile must never outrank something you can actually grab.
 *
 * `MarketProfile.hitTest` ignored `y` altogether and claimed `distance: 0` for
 * every point inside its session's x-range — a whole trading day's width. The
 * footprint did the same across the full height of every column. `bestHit` sorts
 * by distance first, so a drawing reporting a truthful 1-6px lost to an area
 * claim of 0, and a fib level could only be selected by clicking it with
 * sub-pixel accuracy.
 *
 * The symptom: on a chart with Studies switched on, a drawn shape could not be
 * re-selected, dragged or deleted, while the same shape behaved correctly on a
 * chart without them.
 *
 * Neither id was consumed anywhere — the readouts come from `hoverAt()` driven by
 * the crosshair, not from hit-testing — so the claims bought a `crosshair` cursor
 * and cost the drawing tier its interactivity. Both were removed; this pins that,
 * because re-adding either would silently break selection again.
 */

import { describe, it, expect } from 'vitest';
import { bestHit, type PrimitiveHit } from '../src/primitives/primitive';
import { MarketProfile } from '../src/profile/market-profile-primitive';
import { Footprint } from '../src/profile';

/** A primitive may or may not implement hitTest; this reads it without assuming. */
const hitTesterOf = (o: object): { hitTest?: unknown } => o as { hitTest?: unknown };

describe('profile hit precedence', () => {
  it('profiles do not participate in hit-testing at all', () => {
    const fp = new Footprint({ tickSize: 0.05 });
    const mp = new MarketProfile(null);
    expect(hitTesterOf(fp).hitTest, 'Footprint must not implement hitTest').toBeUndefined();
    expect(hitTesterOf(mp).hitTest, 'MarketProfile must not implement hitTest').toBeUndefined();
  });

  it('a grabbable drawing wins once nothing claims the area', () => {
    const drawing: PrimitiveHit = {
      externalId: 'draw:d1', zOrder: 'top', distance: 3, cursor: 'move', draggable: true,
    };
    expect(bestHit([null, drawing])?.externalId).toBe('draw:d1');
  });

  it('shows why an area claim could not simply be deprioritised', () => {
    // `bestHit` compares distance before anything else, so even the lowest
    // possible priority on an area claim of 0 still beats a drawing at 3. That
    // is why these hit-tests had to go rather than be re-ranked.
    const areaClaim: PrimitiveHit = {
      externalId: 'area', zOrder: 'normal', distance: 0, cursor: 'crosshair', priority: -100,
    };
    const drawing: PrimitiveHit = {
      externalId: 'draw:d1', zOrder: 'top', distance: 3, cursor: 'move', draggable: true,
    };
    expect(bestHit([areaClaim, drawing])?.externalId).toBe('area');
  });
});
