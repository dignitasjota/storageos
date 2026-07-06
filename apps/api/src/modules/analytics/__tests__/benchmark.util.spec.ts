import { computeMetric, median, percentile, percentileRank } from '../benchmark.util';

describe('benchmark.util', () => {
  describe('percentile / median', () => {
    it('interpola linealmente sobre un array ordenado', () => {
      const v = [10, 20, 30, 40, 50];
      expect(percentile(v, 0)).toBe(10);
      expect(percentile(v, 100)).toBe(50);
      expect(percentile(v, 50)).toBe(30); // mediana
      expect(percentile(v, 25)).toBe(20);
      expect(percentile(v, 75)).toBe(40);
    });

    it('mediana de un número par de elementos interpola el punto medio', () => {
      expect(median([10, 20, 30, 40])).toBe(25);
    });

    it('casos límite: vacío → 0, un solo elemento → ese valor', () => {
      expect(percentile([], 50)).toBe(0);
      expect(percentile([42], 50)).toBe(42);
      expect(percentile([42], 0)).toBe(42);
      expect(percentile([42], 100)).toBe(42);
    });
  });

  describe('percentileRank', () => {
    it('cuenta el % de valores estrictamente por debajo', () => {
      const v = [10, 20, 30, 40, 50];
      expect(percentileRank(v, 30)).toBe(40); // 10 y 20 por debajo → 2/5
      expect(percentileRank(v, 10)).toBe(0); // ninguno por debajo
      expect(percentileRank(v, 60)).toBe(100); // todos por debajo
    });

    it('vector vacío → 0', () => {
      expect(percentileRank([], 5)).toBe(0);
    });
  });

  describe('computeMetric', () => {
    it('devuelve mediana/p25/p75/mine/percentil redondeados', () => {
      const m = computeMetric([10, 20, 30, 40, 50], 40);
      expect(m.median).toBe(30);
      expect(m.p25).toBe(20);
      expect(m.p75).toBe(40);
      expect(m.mine).toBe(40);
      expect(m.myPercentile).toBe(60); // 3 de 5 por debajo de 40
    });

    it('no muta el array de entrada', () => {
      const input = [3, 1, 2];
      computeMetric(input, 2);
      expect(input).toEqual([3, 1, 2]);
    });
  });
});
