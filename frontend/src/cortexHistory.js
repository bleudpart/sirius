// Historique glissant du Cerveau 1, construit uniquement à partir des trames réellement reçues.
// Rien n'est interpolé : un point correspond à un échange terminé détecté entre deux relevés.

export const EXCHANGE_LIMIT = 24;

export function recordFrame(history, frame) {
  const sameRuntime = history?.runtime_id === frame.runtime_id;
  if (sameRuntime && frame.sequence <= history.sequence) return history;
  const node = frame.nodes.find((item) => item.id === "brain_1");
  const settled = node.completed + node.failures;
  let exchanges = sameRuntime ? history.exchanges : [];
  let pending = sameRuntime ? history.pending : null;

  // Le premier fragment est mesuré pendant le flux, avant la fin de l'échange : on le garde en attente.
  if (sameRuntime && node.first_token_ms !== null && node.first_token_ms !== history.first_token_ms) {
    pending = node.first_token_ms;
  }
  if (node.latency_ms !== null && settled > 0) {
    if (!sameRuntime) {
      // Premier relevé : dernier échange connu, dont l'heure et le premier fragment sont inconnus.
      exchanges = [{ at: null, latency_ms: node.latency_ms, first_token_ms: null, failed: false, count: 1 }];
    } else if (settled > history.settled) {
      exchanges = [...exchanges, {
        at: Date.parse(frame.emitted_at), latency_ms: node.latency_ms, first_token_ms: pending,
        failed: node.failures > history.failures, count: settled - history.settled,
      }].slice(-EXCHANGE_LIMIT);
      pending = null;
    }
  }
  return {
    runtime_id: frame.runtime_id, sequence: frame.sequence, settled, failures: node.failures,
    first_token_ms: node.first_token_ms, pending, exchanges,
  };
}

export function exchangeStats(exchanges) {
  if (!exchanges.length) return { count: 0, average: null, last: null, peak: null };
  const values = exchanges.map((exchange) => exchange.latency_ms);
  return {
    count: exchanges.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    last: values[values.length - 1],
    peak: Math.max(...values),
  };
}
