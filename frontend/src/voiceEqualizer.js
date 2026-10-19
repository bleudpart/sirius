export const EQUALIZER_BANDS = [
  { key: "sub", label: "Infra-graves", frequencyLabel: "80 Hz", type: "lowshelf", frequency: 80, q: 0.7 },
  { key: "bass", label: "Graves", frequencyLabel: "250 Hz", type: "peaking", frequency: 250, q: 1 },
  { key: "lowMid", label: "Bas-médiums", frequencyLabel: "500 Hz", type: "peaking", frequency: 500, q: 1 },
  { key: "mid", label: "Médiums", frequencyLabel: "1,2 kHz", type: "peaking", frequency: 1200, q: 1 },
  { key: "treble", label: "Aigus", frequencyLabel: "4 kHz", type: "peaking", frequency: 4000, q: 1 },
  { key: "air", label: "Brillance", frequencyLabel: "10 kHz", type: "highshelf", frequency: 10000, q: 0.7 },
];
const bands = EQUALIZER_BANDS.map(band => band.key);
export const FLAT_EQUALIZER = Object.fromEntries(bands.map(key => [key, 0]));
const activeGraphs = new Set();
let context;

function normalize(value) {
  return Object.fromEntries(bands.map(key => [key,
    Number.isFinite(value?.[key]) ? Math.max(-12, Math.min(12, value[key])) : 0]));
}

export function loadVoiceEqualizer() {
  try {
    return normalize(JSON.parse(localStorage.getItem("sirius_voice_equalizer")));
  } catch (error) {
    console.warn("Égaliseur vocal : réglages illisibles.", error);
    return { ...FLAT_EQUALIZER };
  }
}

function apply(graph, config) {
  bands.forEach((key, index) => graph.filters[index].gain.setTargetAtTime(config[key], context.currentTime, 0.02));
  // Neighbouring bands overlap: estimate the loudest peak as one boost plus half of each neighbour's boost.
  const boosts = bands.map(key => Math.max(0, config[key]));
  const boost = Math.max(0, ...boosts.map((gain, index) =>
    gain + 0.5 * ((boosts[index - 1] || 0) + (boosts[index + 1] || 0))));
  graph.headroom.gain.setTargetAtTime(10 ** (-boost / 20), context.currentTime, 0.02);
}

export function saveVoiceEqualizer(value) {
  const config = normalize(value);
  localStorage.setItem("sirius_voice_equalizer", JSON.stringify(config));
  activeGraphs.forEach(graph => apply(graph, config));
  return config;
}

export async function connectVoiceEqualizer(audio) {
  const config = loadVoiceEqualizer();
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    if (bands.some(key => config[key] !== 0)) {
      const message = "Égaliseur vocal indisponible dans ce navigateur : lecture sans égalisation.";
      console.warn(message);
      window.dispatchEvent(new CustomEvent("sirius-voice-error", { detail: message }));
    }
    return () => {};
  }
  context ||= new AudioContext();
  await context.resume();
  const source = context.createMediaElementSource(audio);
  const headroom = context.createGain();
  const filters = EQUALIZER_BANDS.map(({ type, frequency, q }) => {
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    return filter;
  });
  source.connect(headroom);
  [headroom, ...filters].reduce((previous, next) => { previous.connect(next); return next; })
    .connect(context.destination);
  const graph = { filters, headroom };
  apply(graph, config);
  activeGraphs.add(graph);
  return () => {
    activeGraphs.delete(graph);
    [source, headroom, ...filters].forEach(node => node.disconnect());
  };
}
