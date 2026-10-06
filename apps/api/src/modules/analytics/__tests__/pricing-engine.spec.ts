import {
  decidePrice,
  demandFactors,
  effectiveMonthlyPrice,
  featureMultiplier,
  fitMarketCurve,
  marketConfidence,
  median,
  observationWeight,
  observedRentals,
  marketTrend,
  rentalIntervals,
  statusAt,
} from '../pricing-engine';

const decide = (over: Partial<Parameters<typeof decidePrice>[0]> = {}) =>
  decidePrice({
    currentPrice: 100,
    marketPrice: 100,
    positioningPct: 0,
    demandPct: 0,
    confidence: 'high',
    maxStepPct: 8,
    minPrice: null,
    maxPrice: null,
    daysSinceLastChange: null,
    minDaysBetweenChanges: 30,
    ...over,
  });

describe('pricing-engine', () => {
  describe('observationWeight', () => {
    it('pesa la mitad a los 60 días y deja de contar a los 180', () => {
      const base = { linkedToFacility: true, distanceKm: null, sameZone: false };
      expect(observationWeight({ ...base, ageDays: 0 })).toBe(1);
      expect(observationWeight({ ...base, ageDays: 60 })).toBeCloseTo(0.5);
      expect(observationWeight({ ...base, ageDays: 181 })).toBe(0);
    });

    it('cercanía: ligado > distancia > misma zona > resto', () => {
      const w = (o: Partial<Parameters<typeof observationWeight>[0]>) =>
        observationWeight({
          ageDays: 0,
          linkedToFacility: false,
          distanceKm: null,
          sameZone: false,
          ...o,
        });
      expect(w({ linkedToFacility: true })).toBe(1);
      expect(w({ distanceKm: 3 })).toBeCloseTo(0.5);
      expect(w({ sameZone: true })).toBe(0.6);
      expect(w({})).toBe(0.3);
    });
  });

  describe('fitMarketCurve', () => {
    it('sin datos devuelve null', () => {
      expect(fitMarketCurve([])).toBeNull();
      expect(fitMarketCurve([{ areaM2: 5, price: 50, weight: 0 }])).toBeNull();
    });

    it('con un solo tamaño usa el €/m² (escala lineal)', () => {
      const curve = fitMarketCurve([{ areaM2: 5, price: 50, weight: 1 }])!;
      expect(curve.priceAt(5)).toBeCloseTo(50);
      expect(curve.priceAt(6)).toBeCloseTo(60);
    });

    it('ajusta una curva en la que el €/m² baja con el tamaño', () => {
      // precio = 20·m²^0.7
      const obs = [2, 4, 8, 16].map((a) => ({ areaM2: a, price: 20 * a ** 0.7, weight: 1 }));
      const curve = fitMarketCurve(obs)!;
      expect(curve.priceAt(6)).toBeCloseTo(20 * 6 ** 0.7, 1);
      expect(curve.priceAt(16) / 16).toBeLessThan(curve.priceAt(2) / 2);
    });

    it('un dato que pesa más arrastra la curva', () => {
      const curve = fitMarketCurve([
        { areaM2: 5, price: 50, weight: 1 },
        { areaM2: 5, price: 100, weight: 0.1 },
      ])!;
      expect(curve.priceAt(5)).toBeCloseTo(50);
    });
  });

  describe('marketConfidence', () => {
    it('depende del nº efectivo de datos y de no extrapolar', () => {
      const many = fitMarketCurve(
        [3, 4, 5, 6, 7].map((a) => ({ areaM2: a, price: a * 10, weight: 1 })),
      );
      expect(marketConfidence(many, 5)).toBe('high');
      expect(marketConfidence(many, 30)).toBe('low');
      const two = fitMarketCurve([
        { areaM2: 4, price: 40, weight: 1 },
        { areaM2: 6, price: 60, weight: 1 },
      ]);
      expect(marketConfidence(two, 5)).toBe('medium');
      expect(marketConfidence(null, 5)).toBe('low');
    });
  });

  describe('demandFactors', () => {
    const base = {
      dimOccupied: 9,
      dimTotal: 10,
      facilityOccupancy: 0.9,
      targetOccupancy: 0.88,
      waitlist: 0,
      competitorOccupancy: null,
    };

    it('ocupación en el objetivo no ajusta nada', () => {
      expect(demandFactors({ ...base, dimOccupied: 8.8 * 1, facilityOccupancy: 0.88 })).toEqual([]);
    });

    it('ocupación baja resta, acotado a −10 %', () => {
      const [occ] = demandFactors({ ...base, dimOccupied: 0, facilityOccupancy: 0 });
      expect(occ!.contribution).toBe(-10);
    });

    it('con pocos trasteros se suaviza con la ocupación del local', () => {
      // 1 de 1 ocupado, pero el local al 50 % → no se dispara al +8 %.
      const [occ] = demandFactors({
        ...base,
        dimOccupied: 1,
        dimTotal: 1,
        facilityOccupancy: 0.5,
      });
      expect(occ!.contribution).toBeLessThan(0);
    });

    it('lista de espera y ocupación de la competencia suman', () => {
      const f = demandFactors({ ...base, waitlist: 5, competitorOccupancy: 0.95 });
      expect(f.find((x) => x.key === 'waitlist')!.contribution).toBe(6);
      expect(f.find((x) => x.key === 'competitor_occupancy')!.contribution).toBe(3);
    });
  });

  describe('ritmo de alquiler de la competencia', () => {
    const d = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

    it('cuenta cada paso de libre a ocupado desde la primera vez que se vio libre', () => {
      expect(
        observedRentals([
          { observedAt: d(0), status: 'available' },
          { observedAt: d(10), status: 'available' },
          { observedAt: d(20), status: 'occupied' },
          { observedAt: d(40), status: 'occupied' },
          { observedAt: d(50), status: 'available' },
          { observedAt: d(55), status: 'occupied' },
        ]),
      ).toEqual([20, 5]);
      // Ocupado desde el principio: no hay alquiler observado.
      expect(observedRentals([{ observedAt: d(0), status: 'occupied' }])).toEqual([]);
    });

    it('alquilar rápido suma y lento resta', () => {
      const base = {
        dimOccupied: 88,
        dimTotal: 100,
        facilityOccupancy: 0.88,
        targetOccupancy: 0.88,
        waitlist: 0,
        competitorOccupancy: null,
      };
      const fast = demandFactors({ ...base, competitorDaysToRent: { medianDays: 15, rentals: 4 } });
      expect(fast.find((f) => f.key === 'competitor_speed')!.contribution).toBe(1);
      const slow = demandFactors({ ...base, competitorDaysToRent: { medianDays: 90, rentals: 4 } });
      expect(slow.find((f) => f.key === 'competitor_speed')!.contribution).toBe(-3);
      expect(median([5, 20, 9])).toBe(9);
    });
  });

  describe('precio comparable', () => {
    const base = {
      price: 60,
      insuranceMonthly: 0,
      setupFee: 0,
      promoFreeMonths: 0,
      promoDiscountPct: 0,
      promoDiscountMonths: 0,
    };

    it('sin extras es su precio', () => {
      expect(effectiveMonthlyPrice(base)).toBe(60);
    });

    it('el primer mes gratis y el descuento bajan el coste medio del primer año', () => {
      expect(effectiveMonthlyPrice({ ...base, promoFreeMonths: 1 })).toBe(55);
      expect(effectiveMonthlyPrice({ ...base, promoDiscountPct: 50, promoDiscountMonths: 2 })).toBe(
        55,
      );
    });

    it('el seguro obligatorio y el alta lo suben', () => {
      expect(effectiveMonthlyPrice({ ...base, insuranceMonthly: 5, setupFee: 24 })).toBe(67);
    });
  });

  describe('características', () => {
    it('ajusta la referencia según lo que tiene cada uno', () => {
      expect(featureMultiplier(['climate'], [])).toBeCloseTo(1.08);
      expect(featureMultiplier([], ['climate', 'cctv'])).toBeCloseTo(0.9);
      expect(featureMultiplier(['24h'], ['24h'])).toBe(1);
    });
  });

  describe('tu ritmo de alquiler', () => {
    const base = {
      dimOccupied: 88,
      dimTotal: 100,
      facilityOccupancy: 0.88,
      targetOccupancy: 0.88,
      waitlist: 0,
      competitorOccupancy: null,
    };
    it('poco stock para el ritmo de alquiler suma; mucho stock resta', () => {
      const fast = demandFactors({ ...base, ownRentals: { rentals90: 6, available: 1 } });
      expect(fast.find((f) => f.key === 'own_speed')!.contribution).toBe(2.3);
      const slow = demandFactors({ ...base, ownRentals: { rentals90: 3, available: 10 } });
      expect(slow.find((f) => f.key === 'own_speed')!.contribution).toBe(-3);
      // Con menos de 2 alquileres no se usa.
      const few = demandFactors({ ...base, ownRentals: { rentals90: 1, available: 10 } });
      expect(few.some((f) => f.key === 'own_speed')).toBe(false);
    });
  });

  describe('contactos', () => {
    const base = {
      dimOccupied: 88,
      dimTotal: 100,
      facilityOccupancy: 0.88,
      targetOccupancy: 0.88,
      waitlist: 0,
      competitorOccupancy: null,
    };
    it('los interesados suman (hasta +3 %) y los perdidos por precio restan (desde 2)', () => {
      const f = demandFactors({ ...base, leads: { open: 5, lostTooExpensive: 2 } });
      expect(f.find((x) => x.key === 'open_leads')!.contribution).toBe(3);
      expect(f.find((x) => x.key === 'lost_price')!.contribution).toBe(-3);
      const one = demandFactors({ ...base, leads: { open: 0, lostTooExpensive: 1 } });
      expect(one).toEqual([]);
      const many = demandFactors({ ...base, leads: { open: 0, lostTooExpensive: 9 } });
      expect(many.find((x) => x.key === 'lost_price')!.contribution).toBe(-4);
    });
  });

  describe('tendencia del mercado', () => {
    const now = new Date(Date.UTC(2026, 6, 1));
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const unit = (from: number, to: number) => ({
      observations: [
        { observedAt: ago(150), price: from },
        { observedAt: ago(10), price: to },
      ],
    });

    it('mediana de la variación con al menos 3 trasteros y 60 días entre revisiones', () => {
      const t = marketTrend([unit(100, 106), unit(50, 53), unit(80, 80)], now)!;
      expect(t.changePct).toBe(6);
      expect(t.units).toBe(3);
      expect(t.months).toBe(5);
      expect(marketTrend([unit(100, 106), unit(50, 53)], now)).toBeNull();
      // Revisiones demasiado juntas: no cuentan.
      const close = {
        observations: [
          { observedAt: ago(20), price: 50 },
          { observedAt: ago(10), price: 60 },
        ],
      };
      expect(marketTrend([close, close, close], now)).toBeNull();
    });
  });

  describe('historial de mis trasteros', () => {
    const d = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));
    it('periodos libres que terminaron en alquiler y estado en una fecha', () => {
      const history = [
        { occurredAt: d(10), newStatus: 'occupied' },
        { occurredAt: d(40), newStatus: 'available' },
        { occurredAt: d(45), newStatus: 'maintenance' },
        { occurredAt: d(50), newStatus: 'available' },
        { occurredAt: d(70), newStatus: 'reserved' },
      ];
      expect(rentalIntervals(d(0), history).map((i) => [i.from.getTime(), i.to.getTime()])).toEqual(
        [
          [d(0).getTime(), d(10).getTime()],
          [d(50).getTime(), d(70).getTime()],
        ],
      );
      expect(statusAt(history, d(20))).toBe('occupied');
      expect(statusAt(history, d(55))).toBe('available');
      expect(statusAt(history, d(-1))).toBe('available');
    });
  });

  describe('decidePrice', () => {
    it('sube hacia el mercado, como mucho el cambio máximo', () => {
      const d = decide({ currentPrice: 80, marketPrice: 100 });
      expect(d.targetPrice).toBe(100);
      expect(d.suggestedPrice).toBe(86); // 80 × 1,08
      expect(d.action).toBe('raise');
    });

    it('con poca confianza el paso es la mitad', () => {
      expect(decide({ currentPrice: 80, confidence: 'low' }).suggestedPrice).toBe(83);
    });

    it('aplica posicionamiento y demanda sobre el mercado', () => {
      expect(decide({ positioningPct: 5, demandPct: 5 }).targetPrice).toBe(110);
    });

    it('sin mercado se mueve solo por la demanda', () => {
      const d = decide({ marketPrice: null, demandPct: -6 });
      expect(d.targetPrice).toBe(94);
      expect(d.suggestedPrice).toBe(94);
    });

    it('mantiene si el cambio es pequeño o reciente', () => {
      expect(decide({ marketPrice: 101 }).action).toBe('hold');
      const recent = decide({ currentPrice: 80, daysSinceLastChange: 10 });
      expect(recent.action).toBe('hold');
      expect(recent.holdReason).toContain('10 días');
    });

    it('respeta el precio mínimo y máximo del tipo', () => {
      expect(decide({ currentPrice: 80, maxPrice: 82 }).suggestedPrice).toBe(82);
      expect(decide({ currentPrice: 100, marketPrice: 50, minPrice: 97 }).suggestedPrice).toBe(97);
      // Precio actual por debajo del mínimo: se corrige aunque haya cambiado hace poco.
      const below = decide({
        currentPrice: 50,
        marketPrice: 50,
        minPrice: 60,
        daysSinceLastChange: 1,
      });
      expect(below.suggestedPrice).toBe(60);
      expect(below.action).toBe('raise');
    });
  });
});
