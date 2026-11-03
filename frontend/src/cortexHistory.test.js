import { EXCHANGE_LIMIT, exchangeStats, recordFrame } from "./cortexHistory";

const STAMP = "2026-11-02T12:00:00Z";
const frame = (sequence, brain1 = {}, { runtime = "runtime-a", at = STAMP } = {}) => ({
  runtime_id: runtime, sequence, emitted_at: at,
  nodes: [{ id: "brain_1", latency_ms: null, first_token_ms: null, completed: 0, failures: 0, ...brain1 }],
});

describe("recordFrame", () => {
  test("reste vide tant qu'aucun échange n'a été mesuré", () => {
    const history = recordFrame(null, frame(1));
    expect(history.exchanges).toEqual([]);
    expect(history).toMatchObject({ runtime_id: "runtime-a", sequence: 1, settled: 0, pending: null });
  });

  test("garde le dernier échange connu à l'ouverture, sans heure ni premier fragment", () => {
    const history = recordFrame(null, frame(1, { completed: 5, failures: 1, latency_ms: 412, first_token_ms: 30 }));
    expect(history.exchanges).toEqual([{ at: null, latency_ms: 412, first_token_ms: null, failed: false, count: 1 }]);
  });

  test("n'invente pas de point quand la durée est inconnue", () => {
    expect(recordFrame(null, frame(1, { completed: 3 })).exchanges).toEqual([]);
  });

  test("ajoute un point daté par échange terminé détecté entre deux relevés", () => {
    let history = recordFrame(null, frame(1));
    history = recordFrame(history, frame(2, { completed: 1, latency_ms: 300 }, { at: "2026-11-02T12:00:01Z" }));
    expect(history.exchanges).toEqual([{
      at: Date.parse("2026-11-02T12:00:01Z"), latency_ms: 300, first_token_ms: null, failed: false, count: 1,
    }]);
  });

  test("ne crée aucun point quand les compteurs n'ont pas bougé", () => {
    let history = recordFrame(null, frame(1, { completed: 2, latency_ms: 300 }));
    history = recordFrame(history, frame(2, { completed: 2, latency_ms: 300 }));
    expect(history.exchanges).toHaveLength(1);
  });

  test("regroupe les échanges terminés entre deux relevés et signale un échec", () => {
    let history = recordFrame(null, frame(1));
    history = recordFrame(history, frame(2, { completed: 2, failures: 1, latency_ms: 700 }));
    expect(history.exchanges[0]).toMatchObject({ latency_ms: 700, failed: true, count: 3 });
  });

  test("rattache un premier fragment mesuré pendant le flux au prochain échange terminé", () => {
    let history = recordFrame(null, frame(1));
    history = recordFrame(history, frame(2, { first_token_ms: 24 }));
    expect(history.exchanges).toEqual([]);
    expect(history.pending).toBe(24);
    history = recordFrame(history, frame(3, { first_token_ms: 24, completed: 1, latency_ms: 410 }));
    expect(history.exchanges[0]).toMatchObject({ latency_ms: 410, first_token_ms: 24 });
    expect(history.pending).toBeNull();
  });

  test("ne réutilise pas un premier fragment déjà associé à un échange précédent", () => {
    let history = recordFrame(null, frame(1));
    history = recordFrame(history, frame(2, { first_token_ms: 24, completed: 1, latency_ms: 410 }));
    history = recordFrame(history, frame(3, { first_token_ms: 24, completed: 2, latency_ms: 150 }));
    expect(history.exchanges.map((item) => item.first_token_ms)).toEqual([24, null]);
  });

  test("ignore une trame rejouée ou plus ancienne", () => {
    const history = recordFrame(null, frame(5, { completed: 1, latency_ms: 200 }));
    expect(recordFrame(history, frame(5, { completed: 9, latency_ms: 999 }))).toBe(history);
    expect(recordFrame(history, frame(4, { completed: 9, latency_ms: 999 }))).toBe(history);
  });

  test("repart de zéro quand l'instance serveur change", () => {
    let history = recordFrame(null, frame(1, { completed: 4, latency_ms: 200 }));
    history = recordFrame(history, frame(1, { completed: 1, latency_ms: 800 }, { runtime: "runtime-b" }));
    expect(history.runtime_id).toBe("runtime-b");
    expect(history.exchanges).toEqual([{ at: null, latency_ms: 800, first_token_ms: null, failed: false, count: 1 }]);
  });

  test("ne compte pas comme échange la purge de compteurs côté serveur", () => {
    let history = recordFrame(null, frame(1, { completed: 5, latency_ms: 300 }));
    history = recordFrame(history, frame(2, { completed: 2, latency_ms: 300 }));
    expect(history.exchanges).toHaveLength(1);
    expect(history.settled).toBe(2);
    history = recordFrame(history, frame(3, { completed: 3, latency_ms: 350 }));
    expect(history.exchanges).toHaveLength(2);
    expect(history.exchanges[1]).toMatchObject({ latency_ms: 350, count: 1 });
  });

  test(`conserve au plus ${EXCHANGE_LIMIT} échanges, les plus récents`, () => {
    let history = recordFrame(null, frame(1));
    for (let index = 1; index <= EXCHANGE_LIMIT + 6; index += 1) {
      history = recordFrame(history, frame(index + 1, { completed: index, latency_ms: 100 + index }));
    }
    expect(history.exchanges).toHaveLength(EXCHANGE_LIMIT);
    expect(history.exchanges[EXCHANGE_LIMIT - 1].latency_ms).toBe(100 + EXCHANGE_LIMIT + 6);
    expect(history.exchanges[0].latency_ms).toBe(100 + 7);
  });
});

describe("exchangeStats", () => {
  test("ne calcule rien sans échange", () => {
    expect(exchangeStats([])).toEqual({ count: 0, average: null, last: null, peak: null });
  });

  test("résume la durée des échanges mesurés", () => {
    const stats = exchangeStats([{ latency_ms: 300 }, { latency_ms: 900 }, { latency_ms: 600 }]);
    expect(stats).toEqual({ count: 3, average: 600, last: 600, peak: 900 });
  });
});
